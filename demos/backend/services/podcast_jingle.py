"""Procedural "Oz Radio" sonic logo — the intro / outro jingle.

An original motif synthesised from scratch with ffmpeg (no samples, no
existing melody): soft FM bell voices (carrier:modulator 1:1 with a decaying
modulation index → a bright "ping" settling into a pure tone) play a D-major
arpeggio over a warm open-fifth pad, with a quiet ping-pong echo for space.

* ``intro`` (``INTRO_SEC`` = 2.0 s): D4 → F♯4 → A4 rising, resolving on a
  sustained D5.
* ``outro`` (``OUTRO_SEC`` = 1.5 s): the softer mirror image — D5 → A4 → F♯4
  falling, resolving on D4.

``render_jingle`` writes WAV pcm_s16le, stereo, 48 kHz with a peak of
≈ ``PEAK_DBFS`` (−18 dBFS); the radio mix and the video title cards
loudness-normalise downstream. Every bell starts after a 20 ms pre-roll with
a 10 ms raised-cosine attack and the tail ends on a half-sine fade, so there
is no click at either end; the synthesis is zero-mean (sine carriers) and a
high-pass guards against any DC. The graph only uses long-standing filters
(aevalsrc, adelay, pan, amix ``normalize=0``, volume, highpass, afade, atrim)
so it runs unchanged on Debian's ffmpeg 5.1. Rendering is deterministic and
cheap (about half a second of CPU), so there is no cache: callers render on
demand.

Preview (cwd ``demos/backend``)::

    python -m services.podcast_jingle --preview <dir>
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional, get_args

log = logging.getLogger(__name__)

JingleKind = Literal["intro", "outro"]

JINGLE_VERSION = 1
INTRO_SEC = 2.0
OUTRO_SEC = 1.5
PEAK_DBFS = -18.0          # nominal sample peak of the rendered file
SAMPLE_RATE = 48000

ATTACK_SEC = 0.010         # bell attack (raised cosine)
GUARD_FADE_SEC = 0.005     # master fade-in, a guard against any start click
HIGHPASS_HZ = 30

# FM bell timbre: the index decays from `index` towards INDEX_FLOOR × index.
INDEX_DECAY_SEC = 0.15
INDEX_FLOOR = 0.3
TINE_RATIO = 4             # two octaves up: a short glassy "tine" on the attack
TINE_GAIN = 0.2
TINE_DECAY_SEC = 0.07
PAD_PARTIALS = (1.0, 0.25, 0.08)   # relative levels of 1f, 2f, 3f

_NOTE_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def pitch_hz(pitch: str) -> float:
    """Equal-tempered frequency (A4 = 440 Hz) of a name like ``"F#4"``."""
    name, octave = pitch[:-1], int(pitch[-1])
    step = _NOTE_STEPS[name[0]] + name[1:].count("#") - name[1:].count("b")
    midi = 12 * (octave + 1) + step
    return 440.0 * 2.0 ** ((midi - 69) / 12)


@dataclass(frozen=True)
class BellNote:
    pitch: str        # scientific pitch name, e.g. "F#4"
    onset: float      # s from the start of the jingle (whole milliseconds)
    gain: float       # linear amplitude before the master gain
    decay: float      # s, amplitude time constant
    pan: float        # -1 left … +1 right
    index: float      # FM modulation index at the attack (brightness)

    @property
    def freq(self) -> float:
        return pitch_hz(self.pitch)


@dataclass(frozen=True)
class PadTone:
    pitch: str
    gain: float
    pan: float

    @property
    def freq(self) -> float:
        return pitch_hz(self.pitch)


@dataclass(frozen=True)
class EchoTap:
    """A darker repeat of every bell note (ping-pong delay built by construction)."""

    delay: float      # s after the note onset (whole milliseconds)
    gain: float       # relative to the note
    pan: float        # absolute position of the repeat
    brightness: float  # multiplier of the note's FM index and tine (darker repeats)


@dataclass(frozen=True)
class JingleSpec:
    kind: str
    duration: float
    notes: tuple[BellNote, ...]
    pad: tuple[PadTone, ...]
    echoes: tuple[EchoTap, ...]
    pad_attack: float
    pad_decay: float
    fade_out: float
    master_gain_db: float

    @property
    def fade_start(self) -> float:
        return self.duration - self.fade_out

    def worst_case_peak(self) -> float:
        """Upper bound of the output peak (linear, per channel).

        Assumes every voice hits its maximum on the same sample in phase,
        which never happens — the real peak sits far below. Kept under
        full scale so the jingle can never clip whatever the phases.
        """
        voices = _voices(self)
        left = sum(v.amplitude * _pan_gains(v.pan)[0] for v in voices)
        right = sum(v.amplitude * _pan_gains(v.pan)[1] for v in voices)
        return max(left, right) * 10 ** (self.master_gain_db / 20)


_ECHOES = (
    EchoTap(delay=0.36, gain=0.30, pan=0.55, brightness=0.5),
    EchoTap(delay=0.72, gain=0.12, pan=-0.55, brightness=0.3),
)

_SPECS: dict[str, JingleSpec] = {
    "intro": JingleSpec(
        kind="intro",
        duration=INTRO_SEC,
        notes=(
            BellNote("D4", onset=0.020, gain=0.80, decay=0.50, pan=-0.30, index=1.4),
            BellNote("F#4", onset=0.200, gain=0.80, decay=0.50, pan=0.30, index=1.4),
            BellNote("A4", onset=0.380, gain=0.80, decay=0.55, pan=-0.10, index=1.4),
            BellNote("D5", onset=0.560, gain=1.00, decay=1.10, pan=0.00, index=1.1),
        ),
        pad=(PadTone("D3", gain=0.20, pan=-0.40), PadTone("A3", gain=0.15, pan=0.40)),
        echoes=_ECHOES,
        pad_attack=0.45,
        pad_decay=2.5,
        fade_out=0.35,
        master_gain_db=-21.13,
    ),
    "outro": JingleSpec(
        kind="outro",
        duration=OUTRO_SEC,
        notes=(
            BellNote("D5", onset=0.020, gain=0.70, decay=0.45, pan=0.10, index=1.0),
            BellNote("A4", onset=0.200, gain=0.75, decay=0.45, pan=-0.25, index=1.0),
            BellNote("F#4", onset=0.380, gain=0.75, decay=0.50, pan=0.25, index=1.0),
            BellNote("D4", onset=0.560, gain=1.00, decay=0.90, pan=0.00, index=0.8),
        ),
        pad=(PadTone("D3", gain=0.18, pan=-0.40), PadTone("A3", gain=0.13, pan=0.40)),
        echoes=_ECHOES,
        pad_attack=0.30,
        pad_decay=2.0,
        fade_out=0.35,
        master_gain_db=-19.96,
    ),
}


def jingle_spec(kind: JingleKind) -> JingleSpec:
    """The musical definition of the intro or outro logo."""
    try:
        return _SPECS[kind]
    except KeyError:
        raise ValueError(f"unknown jingle kind {kind!r} (expected one of {get_args(JingleKind)})") from None


def jingle_duration(kind: JingleKind) -> float:
    return jingle_spec(kind).duration


# ---------------------------------------------------------------------------
# Voices → ffmpeg graph (pure)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Voice:
    expr: str          # mono aevalsrc expression of the local time t
    onset: float
    length: float
    gain: float
    pan: float
    amplitude: float   # max |sample| of the voice, gain included


def _num(x: float) -> str:
    """Plain decimal (no exponent, no SI suffix) for ffmpeg expressions/options."""
    text = f"{x:.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _ms(sec: float) -> int:
    return round(sec * 1000)


def _pan_gains(pan: float) -> tuple[float, float]:
    """Constant-power pan law (−3 dB per side at the centre)."""
    theta = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4
    return math.cos(theta), math.sin(theta)


def _ramp(sec: float) -> str:
    return f"if(lt(t,{_num(sec)}),0.5-0.5*cos(PI*t/{_num(sec)}),1)"


def _bell_expr(freq: float, decay: float, index: float, tine: float) -> str:
    # ld(0) = carrier phase. The tine is skipped once it has decayed below
    # −70 dB (8 time constants): aevalsrc evaluates the expression per sample.
    mod = f"{_num(index)}*({_num(1 - INDEX_FLOOR)}*exp(-t/{_num(INDEX_DECAY_SEC)})+{_num(INDEX_FLOOR)})"
    tine_term = (
        f"if(lt(t,{_num(8 * TINE_DECAY_SEC)}),"
        f"{_num(tine)}*exp(-t/{_num(TINE_DECAY_SEC)})*sin({TINE_RATIO}*ld(0)),0)"
    )
    return (
        f"st(0,2*PI*{_num(freq)}*t);"
        f"{_ramp(ATTACK_SEC)}*exp(-t/{_num(decay)})*(sin(ld(0)+{mod}*sin(ld(0)))+{tine_term})"
    )


def _pad_expr(freq: float, attack: float, decay: float) -> str:
    partials = "+".join(f"{_num(level)}*sin({k}*ld(0))" for k, level in enumerate(PAD_PARTIALS, start=1))
    return f"st(0,2*PI*{_num(freq)}*t);{_ramp(attack)}*exp(-t/{_num(decay)})*({partials})"


def _voices(spec: JingleSpec) -> list[_Voice]:
    voices: list[_Voice] = []
    for note in spec.notes:
        voices.append(_Voice(
            expr=_bell_expr(note.freq, note.decay, note.index, TINE_GAIN),
            onset=note.onset,
            length=spec.duration - note.onset,
            gain=note.gain,
            pan=note.pan,
            amplitude=note.gain * (1.0 + TINE_GAIN),
        ))
        for tap in spec.echoes:
            onset = note.onset + tap.delay
            if onset >= spec.fade_start:     # would only sound inside the fade-out
                continue
            gain = note.gain * tap.gain
            tine = TINE_GAIN * tap.brightness
            voices.append(_Voice(
                expr=_bell_expr(note.freq, note.decay, note.index * tap.brightness, tine),
                onset=onset,
                length=spec.duration - onset,
                gain=gain,
                pan=tap.pan,
                amplitude=gain * (1.0 + tine),
            ))
    pad_peak = sum(PAD_PARTIALS)
    for tone in spec.pad:
        voices.append(_Voice(
            expr=_pad_expr(tone.freq, spec.pad_attack, spec.pad_decay),
            onset=0.0,
            length=spec.duration,
            gain=tone.gain,
            pan=tone.pan,
            amplitude=tone.gain * pad_peak,
        ))
    return voices


def jingle_filtergraph(kind: JingleKind, sample_rate: int = SAMPLE_RATE) -> tuple[list[str], str]:
    """ffmpeg input args + ``-filter_complex`` graph rendering ``kind``; output pad ``[out]``.

    The single input is a silent stereo bed of the exact jingle length (it
    fixes the mix length). Each voice — a bell note, an echo repeat or a pad
    tone — is an ``aevalsrc`` source inside the graph, generated from t = 0,
    then delayed to its onset, panned and summed without normalisation.
    """
    spec = jingle_spec(kind)
    total_samples = round(spec.duration * sample_rate)
    inputs = [
        "-f", "lavfi",
        "-i", f"aevalsrc=exprs=0|0:s={sample_rate}:d={_num(spec.duration)}:c=stereo",
    ]
    chains: list[str] = []
    mix_pads = ["[0:a]"]
    for i, voice in enumerate(_voices(spec), start=1):
        left, right = _pan_gains(voice.pan)
        delay = f",adelay=delays={_ms(voice.onset)}" if _ms(voice.onset) > 0 else ""
        chains.append(
            f"aevalsrc=exprs='{voice.expr}':s={sample_rate}:d={_num(voice.length)}:c=mono{delay},"
            f"pan=stereo|c0={voice.gain * left:.5f}*c0|c1={voice.gain * right:.5f}*c0[v{i}]"
        )
        mix_pads.append(f"[v{i}]")
    chains.append(
        f"{''.join(mix_pads)}amix=inputs={len(mix_pads)}:normalize=0:duration=first,"
        f"volume={spec.master_gain_db:.2f}dB,"
        f"highpass=f={HIGHPASS_HZ},"
        f"afade=t=in:st=0:d={_num(GUARD_FADE_SEC)},"
        f"afade=t=out:st={_num(spec.fade_start)}:d={_num(spec.fade_out)}:curve=hsin,"
        f"atrim=end_sample={total_samples}[out]"
    )
    return inputs, ";".join(chains)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_jingle(kind: JingleKind, path: Path, *, sample_rate: int = SAMPLE_RATE) -> Path:
    """Render the ``kind`` logo to ``path`` (WAV pcm_s16le, stereo) and return it.

    Always renders (deterministic and cheap). The file is written to a
    temporary sibling first and moved into place, so concurrent renders of
    the same path never expose a partial WAV.
    """
    spec = jingle_spec(kind)
    _require_tool("ffmpeg")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    inputs, graph = jingle_filtergraph(kind, sample_rate)
    tmp = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp.wav")
    try:
        _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            *inputs,
            "-filter_complex", graph,
            "-map", "[out]",
            "-c:a", "pcm_s16le", "-ar", str(sample_rate), "-ac", "2",
            "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-f", "wav", str(tmp),
        ])
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    log.info("podcast jingle: rendered %s v%d (%.2f s) to %s", kind, JINGLE_VERSION, spec.duration, path.name)
    return path


def _run(cmd: list[str]) -> None:
    log.debug("$ %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log.error("ffmpeg failed: %s\nSTDERR: %s", " ".join(cmd[:3]), proc.stderr[-2000:])
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-500:]}")


def _require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"required tool missing on PATH: {name}")


def _main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m services.podcast_jingle",
        description="Render the Oz Radio sonic logo (intro + outro) for listening.",
    )
    parser.add_argument("--preview", metavar="DIR", type=Path, required=True,
                        help="output directory for intro/outro .wav and .mp3")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for kind in get_args(JingleKind):
        wav = render_jingle(kind, args.preview / f"{kind}.wav")
        mp3 = wav.with_suffix(".mp3")
        _run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "192k", str(mp3),
        ])
        print(f"{kind}: {wav.resolve()} | {mp3.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
