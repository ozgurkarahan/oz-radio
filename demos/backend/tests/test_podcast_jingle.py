"""Tests for the procedural "Oz Radio" sonic logo (services/podcast_jingle.py).

Pure tests pin the musical spec and the ffmpeg graph (no ffmpeg needed). The
smoke tests render both kinds with the real ffmpeg — skipped when it is not
on PATH — and check format, duration, level, clean edges, DC, stereo image
and the tonic resolution.
"""

from __future__ import annotations

import array
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
# Make `services.*` importable when pytest is run from the repo root.
sys.path.insert(0, str(BACKEND_DIR))

from services import podcast_jingle as pj  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
KINDS = ("intro", "outro")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")

# Filters (with the options used) verified against FFmpeg release/5.1, the
# version shipped by Debian in the production image.
ALLOWED_FILTERS = {"aevalsrc", "adelay", "pan", "amix", "volume", "highpass", "afade", "atrim"}

# The sound is pinned: change it → bump JINGLE_VERSION and update the digests
# (consumers may key cached renders on the version).
GRAPH_DIGESTS = {
    1: {"intro": "fdedf5c48495d85f", "outro": "3c804b09ebeeebee"},
}


def _filter_names(graph: str) -> set[str]:
    unquoted = re.sub(r"'[^']*'", "''", graph)
    names = set()
    for chain in unquoted.split(";"):
        for part in chain.split(","):
            names.add(re.sub(r"^(\[[^\]]*\])+", "", part).split("=", 1)[0])
    return names


# ---------------------------------------------------------------------------
# Pure: spec and graph
# ---------------------------------------------------------------------------

def test_durations_match_the_constants():
    assert pj.jingle_spec("intro").duration == pj.INTRO_SEC == pytest.approx(2.0)
    assert pj.jingle_spec("outro").duration == pj.OUTRO_SEC == pytest.approx(1.5)
    for kind in KINDS:
        assert pj.jingle_duration(kind) == pj.jingle_spec(kind).duration


def test_pitches_are_equal_tempered():
    assert pj.pitch_hz("A4") == pytest.approx(440.0)
    assert pj.pitch_hz("D5") == pytest.approx(587.330, abs=1e-3)
    assert pj.pitch_hz("F#4") == pytest.approx(369.994, abs=1e-3)
    assert pj.pitch_hz("Gb4") == pytest.approx(pj.pitch_hz("F#4"))
    assert pj.pitch_hz("D3") == pytest.approx(pj.pitch_hz("D4") / 2)


def test_intro_rises_and_outro_is_its_descending_mirror():
    intro = [n.pitch for n in pj.jingle_spec("intro").notes]
    outro = [n.pitch for n in pj.jingle_spec("outro").notes]
    assert intro == ["D4", "F#4", "A4", "D5"]
    assert outro == intro[::-1]
    intro_hz = [n.freq for n in pj.jingle_spec("intro").notes]
    assert intro_hz == sorted(intro_hz)


@pytest.mark.parametrize("kind", KINDS)
def test_motif_is_three_notes_resolving_on_a_sustained_tonic(kind):
    spec = pj.jingle_spec(kind)
    assert len(spec.notes) == 4
    onsets = [n.onset for n in spec.notes]
    assert onsets == sorted(onsets) and len(set(onsets)) == 4
    tonic = spec.notes[-1]
    assert tonic.pitch.startswith("D")
    assert tonic.decay == max(n.decay for n in spec.notes)
    assert tonic.gain == max(n.gain for n in spec.notes)
    assert spec.fade_start - tonic.onset >= 0.5      # room to ring before the fade
    assert [p.pitch for p in spec.pad] == ["D3", "A3"]  # open-fifth bed


@pytest.mark.parametrize("kind", KINDS)
def test_voices_are_timed_inside_the_jingle(kind):
    spec = pj.jingle_spec(kind)
    voices = pj._voices(spec)
    assert len(voices) > len(spec.notes) + len(spec.pad)     # echo repeats present
    for voice in voices:
        assert 0 <= voice.onset < spec.fade_start
        assert voice.onset + voice.length == pytest.approx(spec.duration)
        assert voice.onset * 1000 == pytest.approx(round(voice.onset * 1000), abs=1e-6)
    assert min(n.onset for n in spec.notes) >= 0.015          # pre-roll: silent first 5 ms
    assert pj.ATTACK_SEC == pytest.approx(0.010)
    assert 0.3 <= spec.fade_out <= 0.4


@pytest.mark.parametrize("kind", KINDS)
def test_levels_can_never_clip(kind):
    spec = pj.jingle_spec(kind)
    # Even with every voice peaking on the same sample in phase: ≤ −3 dBFS.
    assert 20 * math.log10(spec.worst_case_peak()) <= -3.0
    assert spec.master_gain_db < 0
    for note in spec.notes:
        assert 0 < note.gain <= 1 and -1 <= note.pan <= 1 and 0 < note.index <= 2 and note.decay > 0
    for tone in spec.pad:
        assert 0 < tone.gain <= 0.3
    for tap in spec.echoes:
        assert 0 < tap.gain < 0.5 and 0 < tap.brightness <= 1 and -1 <= tap.pan <= 1


@pytest.mark.parametrize("kind", KINDS)
def test_filtergraph_structure(kind):
    spec = pj.jingle_spec(kind)
    voices = pj._voices(spec)
    inputs, graph = pj.jingle_filtergraph(kind)
    assert inputs[:3] == ["-f", "lavfi", "-i"] and inputs.count("-i") == 1
    assert inputs[3] == f"aevalsrc=exprs=0|0:s=48000:d={pj._num(spec.duration)}:c=stereo"
    assert graph.count("aevalsrc=") == len(voices)
    assert f"amix=inputs={len(voices) + 1}:normalize=0:duration=first" in graph
    assert f"volume={spec.master_gain_db:.2f}dB" in graph
    assert f"afade=t=out:st={pj._num(spec.fade_start)}:d={pj._num(spec.fade_out)}:curve=hsin" in graph
    assert graph.endswith(f"atrim=end_sample={round(spec.duration * 48000)}[out]")


@pytest.mark.parametrize("kind", KINDS)
def test_graph_uses_only_long_standing_filters(kind):
    inputs, graph = pj.jingle_filtergraph(kind)
    assert _filter_names(graph) | _filter_names(inputs[3]) <= ALLOWED_FILTERS


@pytest.mark.parametrize("kind", KINDS)
def test_expressions_are_safe_inside_the_quoted_graph(kind):
    for voice in pj._voices(pj.jingle_spec(kind)):
        assert not set(voice.expr) & set(":'\\|[] ")
        assert not re.search(r"\d[eE][-+]?\d", voice.expr)      # no exponent notation


def test_filtergraph_follows_the_sample_rate():
    inputs, graph = pj.jingle_filtergraph("intro", sample_rate=44100)
    assert ":s=44100:" in inputs[3]
    assert graph.count(":s=44100:") == graph.count("aevalsrc=")
    assert graph.endswith("atrim=end_sample=88200[out]")


def test_graph_is_deterministic_and_pinned_to_the_version():
    for kind in KINDS:
        assert pj.jingle_filtergraph(kind) == pj.jingle_filtergraph(kind)
        digest = hashlib.sha256(json.dumps(pj.jingle_filtergraph(kind)).encode()).hexdigest()[:16]
        assert GRAPH_DIGESTS.get(pj.JINGLE_VERSION, {}).get(kind) == digest, (
            f"the {kind} sound changed: bump JINGLE_VERSION and pin {digest!r}"
        )


def test_unknown_kind_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        pj.jingle_spec("bumper")
    with pytest.raises(ValueError):
        pj.render_jingle("bumper", tmp_path / "bumper.wav")


def test_render_requires_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr(pj.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ffmpeg"):
        pj.render_jingle("intro", tmp_path / "intro.wav")
    assert not list(tmp_path.iterdir())


# ---------------------------------------------------------------------------
# Smoke: real ffmpeg renders
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    out = tmp_path_factory.mktemp("jingle")
    return {kind: pj.render_jingle(kind, out / f"{kind}.wav") for kind in KINDS}


def _read_wav(path: Path) -> tuple:
    """(params, left samples, right samples) of a 16-bit stereo WAV."""
    with wave.open(str(path), "rb") as w:
        params = w.getparams()
        frames = array.array("h", w.readframes(w.getnframes()))
    if sys.byteorder == "big":
        frames.byteswap()
    return params, frames[0::2], frames[1::2]


def _volumedetect(path: Path) -> tuple[float, float]:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    level = r":\s*(-?inf|-?[\d.]+) dB"
    return (float(re.search("max_volume" + level, proc.stderr).group(1)),
            float(re.search("mean_volume" + level, proc.stderr).group(1)))


def _correlation(a: array.array, b: array.array) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    return cov / math.sqrt(va * vb)


def _tone_power(samples: list[int], rate: int, freq: float) -> float:
    """Goertzel power of one frequency."""
    k = 2 * math.cos(2 * math.pi * freq / rate)
    s1 = s2 = 0.0
    for x in samples:
        s1, s2 = x + k * s1 - s2, s1
    return s1 * s1 + s2 * s2 - k * s1 * s2


@pytest.mark.slow
@needs_ffmpeg
@pytest.mark.parametrize("kind", KINDS)
def test_render_is_48k_stereo_s16_of_the_right_length(rendered, kind):
    params, _, _ = _read_wav(rendered[kind])
    assert (params.nchannels, params.sampwidth, params.framerate) == (2, 2, 48000)
    assert params.comptype == "NONE"
    assert params.nframes / params.framerate == pytest.approx(pj.jingle_duration(kind), abs=0.05)
    assert sorted(p.name for p in rendered[kind].parent.iterdir()) == ["intro.wav", "outro.wav"]


@pytest.mark.slow
@needs_ffmpeg
@pytest.mark.parametrize("kind", KINDS)
def test_render_level_is_about_minus_18_dbfs(rendered, kind):
    max_volume, mean_volume = _volumedetect(rendered[kind])
    assert -24.0 <= max_volume <= -14.0
    assert max_volume == pytest.approx(pj.PEAK_DBFS, abs=1.0)
    assert mean_volume > -40.0                       # audible, not silence (≈ −31 dB)


@pytest.mark.slow
@needs_ffmpeg
@pytest.mark.parametrize("kind", KINDS)
def test_render_has_clean_edges_no_dc_and_a_mono_safe_spread(rendered, kind):
    params, left, right = _read_wav(rendered[kind])
    edge = int(0.005 * params.framerate)
    for channel in (left, right):
        assert max(abs(s) for s in channel[:edge]) <= 33    # ≤ −60 dBFS: no click at the start
        assert max(abs(s) for s in channel[-edge:]) <= 33   # nor at the end
        assert abs(sum(channel) / len(channel)) < 0.001 * 32768
        assert max(abs(s) for s in channel) < 32767
    assert 0.6 < _correlation(left, right) < 0.99


@pytest.mark.slow
@needs_ffmpeg
@pytest.mark.parametrize("kind", KINDS)
def test_render_resolves_on_the_tonic(rendered, kind):
    spec = pj.jingle_spec(kind)
    params, left, right = _read_wav(rendered[kind])
    rate = params.framerate
    start, end = int((spec.notes[-1].onset + 0.25) * rate), int(spec.fade_start * rate)
    mono = [lft + rgt for lft, rgt in zip(left[start:end], right[start:end])]
    power = {n.pitch: _tone_power(mono, rate, n.freq) for n in spec.notes}
    assert max(power, key=power.get) == spec.notes[-1].pitch


@pytest.mark.slow
@needs_ffmpeg
def test_preview_cli_writes_wav_and_mp3(tmp_path):
    subprocess.run(
        [sys.executable, "-m", "services.podcast_jingle", "--preview", str(tmp_path)],
        cwd=BACKEND_DIR, check=True, capture_output=True, text=True,
    )
    for kind in KINDS:
        assert (tmp_path / f"{kind}.wav").stat().st_size > 100_000
        assert (tmp_path / f"{kind}.mp3").stat().st_size > 10_000
    assert sorted(p.name for p in tmp_path.iterdir()) == ["intro.mp3", "intro.wav", "outro.mp3", "outro.wav"]
