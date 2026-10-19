"""Smoke tests for the radio mix (services/podcast_radio.py) with the real ffmpeg.

Synthetic "turns" are sine tones with leading/trailing silence (a different
pitch per speaker): TTS-like WAVs and an avatar-like MP4 with an AAC track,
plus a synthetic backchannel. ``mix_radio`` runs once with the intro/outro
logo and reactions, once without the logo but with a looping music bed.
Skipped when ffmpeg is not on PATH.

Run with: pytest demos/backend/tests/test_podcast_radio_smoke.py
"""

from __future__ import annotations

import json
import logging
import math
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

# Make `services.*` importable when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
                       reason="ffmpeg not on PATH"),
]

SR = 48000
SECRET_VOICES = ("en-US-SecretCharacterVoice:DragonHDLatestNeural", "en-US-OtherSecret:DragonHDLatestNeural")
INTERVIEWER_HZ, EXPERT_HZ, REACTION_HZ = 250.0, 400.0, 900.0

# (speaker, segments: ("tone", sec) | ("silence", sec), container, amplitude, sample rate)
# Uneven levels (turn 2 is 12 dB quieter, with plosive-like peaks → raw PLR far
# above what a linear loudnorm accepts) and a 24 kHz WAV (DragonHD's native rate).
TURNS = [
    ("interviewer", [("silence", 0.30), ("tone", 1.20), ("silence", 0.50)], "wav", 0.25, 48000),
    ("expert", [("silence", 0.25), ("tone", 1.00), ("silence", 0.70), ("tone", 0.60), ("silence", 0.40)],
     "mp4", 0.25, 48000),
    ("interviewer", [("silence", 0.30), ("tone", 0.80), ("silence", 0.30)], "wav", 0.0625, 48000),
    ("interviewer", [("silence", 0.20), ("tone", 0.50), ("silence", 0.20)], "wav", 0.25, 24000),
]
TEXTS = [
    "Welcome to the show. Today we talk about radio mixes and why gaps matter so much.",
    "Thanks for having me. Natural timing is everything. Listeners notice long silences.",
    "Interesting point.",
    "Let's dig into the details right after this.",
]
REACTION_AT = 0.25 + 1.00 + 0.15     # inside the expert's 0.70 s pause (turn 1)
REACTION_SEC = 0.35


def _write_wav(path: Path, samples: np.ndarray, rate: int = SR) -> Path:
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return path


def _tone(freq: float, sec: float, amp: float = 0.25, rate: int = SR) -> np.ndarray:
    n = int(round(sec * rate))
    t = np.arange(n) / rate
    ramp = min(n // 2, int(0.005 * rate))
    env = np.ones(n)
    env[:ramp] = 0.5 - 0.5 * np.cos(np.pi * np.arange(ramp) / ramp)
    env[n - ramp:] = env[:ramp][::-1]
    return amp * env * np.sin(2 * np.pi * freq * t)


def _turn_samples(speaker: str, segments, amp: float, rate: int) -> np.ndarray:
    freq = INTERVIEWER_HZ if speaker == "interviewer" else EXPERT_HZ
    parts = []
    for kind, sec in segments:
        if kind == "silence":
            parts.append(np.zeros(int(round(sec * rate))))
            continue
        tone = _tone(freq, sec, amp, rate)
        if amp < 0.1:   # plosive-like clicks: a raw-TTS-like peak-to-loudness ratio
            click = _tone(1500.0, 0.0005, 0.95, rate)
            for at in (0.2, sec - 0.2):
                i = int(at * rate)
                tone[i:i + len(click)] += click
        parts.append(tone)
    return np.concatenate(parts)


def _speech_bounds(segments) -> tuple[float, float]:
    lead = segments[0][1]
    end = sum(sec for _, sec in segments) - segments[-1][1]
    return lead, end


def _ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True, capture_output=True)


def _probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def _ebur128(path: Path) -> tuple[float, float]:
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                           "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
                          capture_output=True, text=True, check=True)
    summary = proc.stderr[proc.stderr.rfind("Summary:"):]
    integrated = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary).group(1))
    true_peak = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary).group(1))
    return integrated, true_peak


def _decode_stereo(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "2", "-ar", str(SR),
                          "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)


def _band_energy(x: np.ndarray, freq: float) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    band = (freqs > freq - 25) & (freqs < freq + 25)
    return float(np.sum(spectrum[band] ** 2))


def _first_frame_tag(path: Path) -> str | None:
    data = path.read_bytes()
    start = 0
    if data[:3] == b"ID3":
        start = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])
    head = data[start:start + 2000]
    return next((tag.decode() for tag in (b"Info", b"Xing", b"VBRI") if tag in head), None)


def _id3_frames(path: Path) -> list[tuple[str, str]]:
    """(frame id, text) of an ID3v2.3 tag, read from the file (ffprobe's console
    output is not UTF-8 safe on Windows). TXXX → "TXXX:<description>"."""
    data = path.read_bytes()
    assert data[:3] == b"ID3" and data[3] == 3
    end = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])
    codecs = {0: "latin-1", 1: "utf-16", 2: "utf-16-be", 3: "utf-8"}
    frames, pos = [], 10
    while pos + 10 <= end and re.fullmatch(rb"[A-Z0-9]{4}", data[pos:pos + 4]):
        frame_id = data[pos:pos + 4].decode()
        size = int.from_bytes(data[pos + 4:pos + 8], "big")
        body = data[pos + 10:pos + 10 + size]
        if frame_id == "APIC":
            frames.append((frame_id, body[1:body.index(b"\x00", 1)].decode("latin-1")))
        elif frame_id.startswith("T"):
            text = body[1:].decode(codecs[body[0]]).rstrip("\x00")
            if frame_id == "TXXX":
                description, _, text = text.partition("\x00")
                frame_id = f"TXXX:{description}"
            frames.append((frame_id, text))
        else:
            frames.append((frame_id, ""))
        pos += 10 + size
    return frames


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    from services.podcast_media import ReactionClip, ReactionPlacement, TurnAudio
    from services.podcast_models import (
        DialogueTurn, PodcastHost, RenderRoles, RoleConfig, Script,
    )

    d = tmp_path_factory.mktemp("radio_media")
    turn_audio = []
    for idx, (speaker, segments, container, amp, rate) in enumerate(TURNS):
        wav = _write_wav(d / f"turn_{idx}.wav", _turn_samples(speaker, segments, amp, rate), rate)
        path = wav
        if container == "mp4":
            path = d / f"turn_{idx}.mp4"
            seconds = sum(sec for _, sec in segments)
            _ff("-f", "lavfi", "-i", f"color=c=0x00FF00:s=128x128:r=25:d={seconds + 0.2:.2f}", "-i", str(wav),
                "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-t", f"{seconds:.3f}", str(path))
        turn_audio.append(TurnAudio(turn_idx=idx, speaker=speaker, path=path,
                                    source="avatar" if container == "mp4" else "tts"))
    ack = _write_wav(d / "ack.wav", _tone(REACTION_HZ, REACTION_SEC, amp=0.3, rate=24000), 24000)
    clips = {"interviewer": {"ack": ReactionClip(reaction_id="ack", text="Mm-hmm.", audio_path=ack,
                                                 video_path=None, duration_sec=REACTION_SEC)}}
    placements = [
        ReactionPlacement(turn_idx=1, listener="interviewer", reaction_id="ack",
                          at_sec=REACTION_AT, duration_sec=REACTION_SEC, gain_db=-4.0),
        # No clip for the expert: skipped, never fatal.
        ReactionPlacement(turn_idx=2, listener="expert", reaction_id="right",
                          at_sec=0.5, duration_sec=0.4, gain_db=-4.0),
    ]
    script = Script(id="scr", document_id="doc", turns=[
        DialogueTurn(idx=i, speaker=turn[0], text=TEXTS[i]) for i, turn in enumerate(TURNS)
    ])
    roles = RenderRoles(
        interviewer=RoleConfig(display_name="Sofia", avatar="photo_female", voice=SECRET_VOICES[0]),
        expert=RoleConfig(display_name="Lucas", avatar="photo_male", voice=SECRET_VOICES[1]),
    )
    hosts = [PodcastHost(role="interviewer", display_name="Sofia", avatar_id="photo_female"),
             PodcastHost(role="expert", display_name="Lucas", avatar_id="photo_male")]
    music = d / "bed.wav"
    _ff("-f", "lavfi", "-i", "aevalsrc=exprs=0.2*sin(2*PI*330*t)|0.2*sin(2*PI*495*t):s=48000:d=3", str(music))
    return {"dir": d, "turns": turn_audio, "clips": clips, "placements": placements, "script": script,
            "roles": roles, "hosts": hosts, "music": music}


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def _mix_logged(**kwargs):
    from services import podcast_radio

    handler = _Records()
    logger = logging.getLogger(podcast_radio.__name__)
    level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        return podcast_radio.mix_radio(**kwargs), handler.messages
    finally:
        logger.removeHandler(handler)
        logger.setLevel(level)


@pytest.fixture(scope="module")
def radio(media):
    warnings: list[str] = []
    result, messages = _mix_logged(
        turn_audio=media["turns"], placements=media["placements"], clips=media["clips"],
        script=media["script"], roles=media["roles"], hosts=media["hosts"],
        title="Radio mixes — les détails", language="fr-FR", out_dir=media["dir"] / "out", intro=True,
        seed="job-123", video_offsets={0: (2.0, 4.0), 1: (4.0, 7.0), 2: (7.0, 8.4), 3: (8.4, 9.3)},
        warnings=warnings,
    )
    return result, warnings, messages


@pytest.fixture(scope="module")
def radio_plain(media):
    result, _ = _mix_logged(
        turn_audio=media["turns"], placements=[], clips={}, script=media["script"], roles=media["roles"],
        hosts=[], title="Plain", language="en-US", out_dir=media["dir"] / "plain", intro=False,
        seed="job-456",
        music_path=media["music"],
    )
    return result


def _expected_speech(seed: str) -> tuple[float, list[float]]:
    from services.podcast_radio import turn_gaps

    spans = [_speech_bounds(turn[1])[1] - _speech_bounds(turn[1])[0] for turn in TURNS]
    return sum(spans), turn_gaps([turn[0] for turn in TURNS], seed)


def test_outputs_exist_and_only_the_deliverables_remain(radio):
    result, _, _ = radio
    out = result.mp3.parent
    assert result.mp3 == out / "audio.mp3" and result.srt == out / "audio.srt"
    assert result.transcript_path == out / "transcript.json" and result.cover == out / "cover.jpg"
    assert result.audio_kind == "radio_mix"
    assert sorted(p.name for p in out.iterdir()) == ["audio.mp3", "audio.srt", "cover.jpg", "transcript.json"]


def test_mp3_is_cbr_44k1_stereo_without_embedded_cover(radio):
    result, _, _ = radio
    info = _probe(result.mp3)
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert audio["codec_name"] == "mp3"
    assert int(audio["sample_rate"]) == 44100 and int(audio["channels"]) == 2
    assert int(audio["bit_rate"]) == 128000
    assert _first_frame_tag(result.mp3) == "Info"          # LAME/Xing header of a CBR stream
    # F7: no picture in the MP3 (an APIC cover delayed the first audio frame on slow links);
    # the cover is the separate 1400 px cover.jpg.
    assert not [s for s in info["streams"] if s["codec_type"] == "video"]
    data = result.mp3.read_bytes()
    assert data[:3] == b"ID3" and 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]) < 2048
    from PIL import Image

    assert Image.open(result.cover).size == (1400, 1400)


def test_id3_tags_are_allow_listed(radio):
    from services.podcast_radio import ID3_KEYS

    result, _, _ = radio
    keys = {k.lower() for k in _probe(result.mp3)["format"].get("tags", {})}
    assert keys <= set(ID3_KEYS)
    frames = dict(_id3_frames(result.mp3))
    # ffmpeg writes the comment as TXXX:comment (no COMM) and, bit-exact, no TSSE; no APIC.
    assert set(frames) == {"TIT2", "TPE1", "TPE2", "TALB", "TCON", "TYER", "TLAN", "TXXX:comment"}
    assert frames["TIT2"] == "Radio mixes — les détails"
    assert frames["TPE1"] == "Sofia & Lucas" and frames["TPE2"] == "Oz Radio"
    assert frames["TALB"] == "Oz Radio Podcasts" and frames["TCON"] == "Podcast"
    assert frames["TLAN"] == "fra" and re.fullmatch(r"20\d\d", frames["TYER"])
    assert frames["TXXX:comment"] == "AI-generated voices"
    raw = result.mp3.read_bytes()
    for secret in SECRET_VOICES:
        assert secret.encode() not in raw and secret.split(":")[0].encode() not in raw
    assert b"turn_" not in raw[:200_000] and b".wav" not in raw[:200_000]


def test_loudness_is_minus_16_lufs_in_linear_mode(radio):
    result, _, messages = radio
    integrated, true_peak = _ebur128(result.mp3)
    assert integrated == pytest.approx(-16.0, abs=1.0)     # a 128k MP3 reads ≈ 0.4 LU low
    assert true_peak <= -1.0
    summary = next(m for m in messages if m.startswith("podcast radio: 4 turns"))
    assert "loudnorm=linear" in summary


def test_turns_are_levelled(radio):
    result, _, _ = radio
    stereo = _decode_stereo(result.mp3)
    levels = []
    for turn in result.transcript.turns:
        seg = stereo[int((turn.start + 0.05) * SR):int((turn.start + 0.45) * SR)]
        levels.append(20 * math.log10(np.sqrt(np.mean(seg ** 2))))
    # Turn 2 was synthesized 12 dB quieter (with plosive peaks): levelled to its neighbours.
    assert max(levels) - min(levels) < 2.5, levels


def test_no_long_leading_silence_and_expected_duration(radio):
    from services.podcast_jingle import INTRO_SEC, OUTRO_SEC
    from services.podcast_radio import INTRO_UNDER_SPEECH_SEC, OUTRO_AFTER_SPEECH_SEC, _decode_pcm

    result, _, _ = radio
    pcm = _decode_pcm(result.mp3, 8000).astype(np.float64) / 32768
    first = int(np.argmax(np.abs(pcm) > 10 ** (-45 / 20)))
    assert first / 8000 < 1.0
    speech, gaps = _expected_speech("job-123")
    expected = (INTRO_SEC - INTRO_UNDER_SPEECH_SEC) + speech + sum(gaps) + OUTRO_AFTER_SPEECH_SEC + OUTRO_SEC
    assert result.duration_sec == pytest.approx(expected, abs=0.08)
    assert len(pcm) / 8000 == pytest.approx(result.duration_sec, abs=0.1)


def test_transcript_validates_and_matches_the_timeline(radio):
    from services.podcast_models import Transcript
    from services.podcast_radio import GAP_MAX_SEC, GAP_MIN_SEC, PEAK_BUCKETS

    result, warnings, _ = radio
    transcript = Transcript.model_validate_json(result.transcript_path.read_text(encoding="utf-8"))
    assert transcript == result.transcript
    assert transcript.duration_sec == result.duration_sec
    assert [h.display_name for h in transcript.hosts] == ["Sofia", "Lucas"]
    turns = transcript.turns
    assert [t.turn_idx for t in turns] == [0, 1, 2, 3]
    assert [t.speaker for t in turns] == [turn[0] for turn in TURNS]
    _, gaps = _expected_speech("job-123")
    for prev, cur, gap in zip(turns, turns[1:], gaps):
        assert prev.end < cur.start
        assert cur.start - prev.end == pytest.approx(gap, abs=0.05)
        assert GAP_MIN_SEC - 0.05 <= cur.start - prev.end <= GAP_MAX_SEC + 0.05
    for turn, spec in zip(turns, TURNS):
        lead, end = _speech_bounds(spec[1])
        assert turn.end - turn.start == pytest.approx(end - lead, abs=0.05)
    assert (turns[1].video_start, turns[1].video_end) == (4.0, 7.0)
    assert len(transcript.peaks) == PEAK_BUCKETS
    assert max(transcript.peaks) == 1.0 and min(transcript.peaks) >= 0.0
    speech = [c for c in transcript.cues if c.kind == "speech"]
    assert {c.turn_idx for c in speech} == {0, 1, 2, 3}
    for cue in speech:
        turn = turns[cue.turn_idx]
        assert turn.start - 1e-6 <= cue.start <= cue.end <= turn.end + 1e-6
        assert len(cue.text) <= 80
    reactions = [c for c in transcript.cues if c.kind == "reaction"]
    assert len(reactions) == 1 and warnings == ["reactions_skipped"]
    ack = reactions[0]
    assert (ack.speaker, ack.turn_idx, ack.text) == ("interviewer", 1, "Mm-hmm.")
    lead_1 = TURNS[1][1][0][1]
    assert ack.start == pytest.approx(turns[1].start + (REACTION_AT - lead_1), abs=0.03)
    assert ack.end - ack.start == pytest.approx(REACTION_SEC, abs=1e-3)
    text = result.transcript_path.read_text(encoding="utf-8")
    for secret in SECRET_VOICES:
        assert secret not in text


def test_reaction_is_audible_on_the_listener_side(radio):
    result, _, _ = radio
    stereo = _decode_stereo(result.mp3)
    ack = next(c for c in result.transcript.cues if c.kind == "reaction")
    window = stereo[int((ack.start + 0.05) * SR):int((ack.end - 0.05) * SR)]
    left, right = _band_energy(window[:, 0], REACTION_HZ), _band_energy(window[:, 1], REACTION_HZ)
    assert left > 1.2 * right > 0                       # interviewer = slightly left
    expert = result.transcript.turns[1]
    speech = stereo[int((expert.start + 0.1) * SR):int((expert.start + 0.9) * SR)]
    assert _band_energy(speech[:, 1], EXPERT_HZ) > 1.2 * _band_energy(speech[:, 0], EXPERT_HZ)
    # Nothing at the reaction pitch outside the reaction (no doubled or misplaced clip).
    assert _band_energy(speech[:, 0], REACTION_HZ) < 0.01 * left


def test_audio_srt_is_radio_timed(radio):
    result, _, _ = radio
    srt = result.srt.read_text(encoding="utf-8")
    blocks = re.findall(r"(\d+)\n(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})\n([^\n]+)\n", srt)
    speech = [c for c in result.transcript.cues if c.kind == "speech"]
    assert len(blocks) == len(speech) > 4
    previous = -1.0
    for block, cue in zip(blocks, speech):
        h, m, s, ms = map(int, block[1:5])
        start = h * 3600 + m * 60 + s + ms / 1000
        assert start == pytest.approx(cue.start, abs=0.002) and start >= previous
        previous = start
        name, _, text = block[9].partition(": ")
        assert name in {"Sofia", "Lucas"} and text == cue.text
    for secret in SECRET_VOICES:
        assert secret not in srt


def test_plain_mix_without_logo_with_music_bed(radio_plain):
    from services.podcast_models import Transcript
    from services.podcast_radio import LAST_TAIL_SEC, LEAD_IN_SEC

    result = radio_plain
    transcript = Transcript.model_validate_json(result.transcript_path.read_text(encoding="utf-8"))
    assert transcript.turns[0].start == pytest.approx(LEAD_IN_SEC, abs=0.03)
    assert [h.display_name for h in transcript.hosts] == ["Sofia", "Lucas"]   # derived from the roles
    assert not [c for c in transcript.cues if c.kind == "reaction"]
    assert transcript.turns[-1].end + min(LAST_TAIL_SEC, TURNS[-1][1][-1][1]) == pytest.approx(
        result.duration_sec, abs=0.03)
    integrated, _ = _ebur128(result.mp3)
    assert integrated == pytest.approx(-16.0, abs=1.0)
    frames = dict(_id3_frames(result.mp3))
    assert frames["TLAN"] == "eng" and frames["TPE1"] == "Sofia & Lucas"
    # The bed is audible between the words (it never stops the mix).
    stereo = _decode_stereo(result.mp3)
    gap = stereo[int((transcript.turns[0].end + 0.02) * SR):int((transcript.turns[1].start - 0.02) * SR)]
    assert np.sqrt(np.mean(gap ** 2)) > 1e-4


def test_peaky_programme_still_normalizes_linearly(tmp_path):
    """Raw-TTS-like PLR (loud clicks over quiet speech): the corrective limiter keeps loudnorm linear."""
    from services.podcast_radio import _measure_loudnorm, _normalize_and_encode, linear_feasible

    t = np.arange(6 * SR) / SR
    harmonics = sum(a * np.sin(2 * np.pi * f * t) for a, f in ((1.0, 130), (0.6, 260), (0.45, 390), (0.25, 650)))
    speech = 0.03 * harmonics * (0.55 + 0.45 * np.sin(2 * np.pi * 4.3 * t))
    click = _tone(2000.0, 0.001, 0.95)
    for at in range(SR // 2, 6 * SR - SR // 2, SR // 3):
        speech[at:at + len(click)] += click
    program = _write_wav(tmp_path / "program.wav", speech)
    raw = _measure_loudnorm(program)
    assert raw is not None and not linear_feasible(raw)     # as raw TTS: PLR too high
    mp3 = tmp_path / "audio.mp3"
    mode = _normalize_and_encode(program, mp3, {"title": "t"}, tmp_path)
    assert mode == "linear"
    integrated, true_peak = _ebur128(mp3)
    assert integrated == pytest.approx(-16.0, abs=1.0) and true_peak <= -1.0


def test_encode_writes_a_small_id3_tag_and_no_picture(tmp_path):
    """F7: an embedded cover (about 125 KB of APIC) delayed the first audio frame on slow links."""
    from services.podcast_radio import _normalize_and_encode

    program = _write_wav(tmp_path / "program.wav", _tone(300.0, 2.0))
    mp3 = tmp_path / "audio.mp3"
    _normalize_and_encode(program, mp3, {"title": "t"}, tmp_path)
    data = mp3.read_bytes()
    assert data[:3] == b"ID3" and 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]) < 2048
    assert "APIC" not in dict(_id3_frames(mp3)) and dict(_id3_frames(mp3))["TIT2"] == "t"
