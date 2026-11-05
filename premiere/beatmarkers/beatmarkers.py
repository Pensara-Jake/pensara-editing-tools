#!/usr/bin/env python3
"""
beatmarkers.py - put a marker on every beat (or every hit of a chosen
instrument) in a music track, for import into Premiere Pro.

Outputs, next to each other in the output folder:
  <name>_markers.xml   FCP7 XML: a sequence holding the track, with one
                       sequence marker per hit. Premiere: File > Import.
  <name>_markers.edl   CMX3600 EDL with marker locators (|M: / *LOC:).
                       DaVinci Resolve and Avid read these markers;
                       Premiere ignores markers in EDLs.
  <name>_markers.csv   Plain list of times, for anything else.

Modes (combine with commas, e.g. --mode kick,snare):
  beats      steady beat grid (tempo-tracked)
  downbeats  first beat of each bar (estimated)
  kick       bass drum hits
  snare      snare / clap hits
  hihat      hi-hat / cymbal hits
  bass       bass-note onsets
  vocals     vocal / lead-melody note onsets
  melody     alias for vocals
  onsets     every transient of any kind

Examples:
  python beatmarkers.py song.wav
  python beatmarkers.py song.mp3 --mode kick,snare --fps 25
  python beatmarkers.py song.wav --mode beats --every 2
  python beatmarkers.py song.wav --mode vocals --separate   # needs demucs
"""

from __future__ import annotations

__version__ = "1.0.0"

import argparse
import csv
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import maximum_filter1d

try:
    import librosa
except ImportError:  # pragma: no cover
    sys.exit("librosa is required:  pip install librosa soundfile")

SR = 44100
HOP = 256  # ~5.8 ms resolution at 44.1 kHz

# Per-instrument settings:
#   source: which part of the signal to analyse (percussive / harmonic / full)
#   band:   frequency range in Hz that the instrument dominates
#   gap:    minimum time between two hits of this instrument, in seconds
#   stem:   demucs stem to use when --separate is on
PRESETS = {
    "kick":   dict(source="percussive", band=(30, 150),     gap=0.10, stem="drums"),
    "snare":  dict(source="percussive", band=(180, 4000),   gap=0.10, stem="drums"),
    "hihat":  dict(source="percussive", band=(7000, 16000), gap=0.05, stem="drums"),
    "bass":   dict(source="harmonic",   band=(35, 250),     gap=0.08, stem="bass"),
    "vocals": dict(source="harmonic",   band=(250, 4000),   gap=0.10, stem="vocals"),
    "onsets": dict(source="full",       band=(30, 16000),   gap=0.05, stem=None),
}
PRESETS["melody"] = PRESETS["vocals"]

# Drums spill into each other's bands (a kick has a mid-range thud that looks
# like a snare; a snare has some low end). A candidate hit is dropped when a
# rival drum's band rises at least `ratio` times as strongly at that moment.
RIVALS = {
    "kick":  [("snare", 2.0)],   # a real kick dominates the low band
    "snare": [("kick", 0.9)],    # kick spill into the snare band is common
}

LABELS = {
    "beats": "Beat", "downbeats": "Bar", "kick": "Kick", "snare": "Snare",
    "hihat": "Hat", "bass": "Bass", "vocals": "Vocal", "melody": "Melody",
    "onsets": "Hit",
}
ALL_MODES = list(LABELS)

# Resolve marker colours used in the EDL, one per mode.
EDL_COLOURS = {
    "beats": "Blue", "downbeats": "Red", "kick": "Red", "snare": "Yellow",
    "hihat": "Cyan", "bass": "Purple", "vocals": "Green", "melody": "Green",
    "onsets": "Blue",
}


@dataclass
class Marker:
    time: float  # seconds
    mode: str
    index: int   # 1-based count within its mode

    @property
    def name(self) -> str:
        return f"{LABELS[self.mode]} {self.index}"


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------

class Analyzer:
    def __init__(self, path: Path, separate: bool = False):
        self.path = path
        self.y, self.sr = librosa.load(str(path), sr=SR, mono=True)
        self.duration = len(self.y) / self.sr
        self._hpss = None
        self._stems: dict[str, np.ndarray] | None = None
        self.separate = separate

    # Harmonic / percussive split (cheap, always available)
    def _split(self):
        if self._hpss is None:
            D = librosa.stft(self.y, n_fft=2048, hop_length=HOP)
            H, P = librosa.decompose.hpss(D, margin=(1.0, 2.0))
            self._hpss = (np.abs(H), np.abs(P), np.abs(D))
        return self._hpss

    # Neural stem separation (optional, via demucs)
    def _stem(self, name: str) -> np.ndarray:
        if self._stems is None:
            self._stems = run_demucs(self.path)
        return self._stems[name]

    def _magnitude(self, preset) -> np.ndarray:
        if self.separate and preset["stem"]:
            stem = self._stem(preset["stem"])
            S = np.abs(librosa.stft(stem, n_fft=2048, hop_length=HOP))
            if preset["source"] == "harmonic":
                S, _ = librosa.decompose.hpss(S, margin=(1.0, 1.0))
            elif preset["source"] == "percussive":
                _, S = librosa.decompose.hpss(S, margin=(1.0, 1.0))
            return S
        H, P, F = self._split()
        return {"harmonic": H, "percussive": P, "full": F}[preset["source"]]

    def band_envelope(self, mode: str) -> np.ndarray:
        """Onset-strength curve for one instrument's frequency band."""
        preset = PRESETS[mode]
        S = self._magnitude(preset)
        freqs = librosa.fft_frequencies(sr=self.sr, n_fft=2048)
        lo, hi = preset["band"]
        hi = min(hi, self.sr / 2 - 1)
        band = (freqs >= lo) & (freqs <= hi)
        # Total energy in the band per frame, in dB. Summing first (rather than
        # per-bin flux) ignores small spill from other instruments.
        energy = (S[band] ** 2).sum(axis=0)
        db = 10 * np.log10(energy + 1e-10)
        db = np.maximum(db, db.max() - 60)  # ignore anything 60 dB below the peak
        # Attack of a new hit = energy rising above the *recent peak* level
        # (last ~35 ms). Comparing against the recent maximum, not just the
        # previous frame, stops wobble in reverb tails reading as new hits.
        lag, win = 2, 6
        past = np.full_like(db, db.min())
        past_max = maximum_filter1d(db, size=win, origin=(win - 1) // 2,
                                    mode="nearest")  # window = this + previous frames
        past[lag:] = past_max[:-lag]
        rise = np.maximum(db - past, 0)
        # Only count rises that reach a level close to this band's real hits:
        # a jump from silence to -40 dB is spill from another instrument,
        # not a hit. Full weight within 12 dB of the band's loud level, fading
        # to zero 30 dB below it.
        loud = np.percentile(db, 99)
        weight = np.clip((db - (loud - 30)) / 18, 0, 1)
        rise = rise * weight
        if rise.max() > 0:
            rise = rise / rise.max()
        return rise

    def _peaks(self, mode: str, sensitivity: float) -> np.ndarray:
        """Candidate hit frames for one band."""
        preset = PRESETS[mode]
        env = self.band_envelope(mode)
        if not env.any():
            return np.array([], dtype=int)
        fps = self.sr / HOP
        gap = max(1, int(round(preset["gap"] * fps)))
        # Higher sensitivity -> lower threshold above the local average.
        delta = float(np.interp(sensitivity, [0, 1], [0.35, 0.02]))
        peaks = librosa.util.peak_pick(
            env, pre_max=3, post_max=3, pre_avg=int(0.1 * fps),
            post_avg=int(0.1 * fps), delta=delta, wait=gap,
        )
        if len(peaks) == 0:
            return peaks
        # Drop weak peaks relative to a typical strong hit of this kind.
        typical = np.percentile(env[peaks], 90)
        floor = typical * float(np.interp(sensitivity, [0, 1], [0.7, 0.1]))
        peaks = peaks[env[peaks] >= floor]
        # The STFT is unreliable in the first/last couple of frames (padding),
        # which produces phantom hits at the very edges of the file.
        edge = 2
        return peaks[(peaks >= edge) & (peaks < len(env) - edge)]

    def _band_power(self, S, lo, hi):
        freqs = librosa.fft_frequencies(sr=self.sr, n_fft=2048)
        return (S[(freqs >= lo) & (freqs <= hi)] ** 2).sum(axis=0)

    def _drum_balance(self, frames: np.ndarray) -> np.ndarray:
        """For each hit: dB of energy the hit *adds* to the low band minus
        dB it adds to the mid band. Kicks score high, snares low. The value
        doesn't depend on how hard the drum was hit."""
        _, P, _ = self._split()
        low = self._band_power(P, *PRESETS["kick"]["band"])
        mid = self._band_power(P, *PRESETS["snare"]["band"])
        out = []
        for f in frames:
            a, b = max(0, f - 6), f + 4  # ~35 ms before vs the attack
            add_low = max(low[f:b].max() - low[a:f].min() if f > a else low[f:b].max(), 1e-10)
            add_mid = max(mid[f:b].max() - mid[a:f].min() if f > a else mid[f:b].max(), 1e-10)
            out.append(10 * np.log10(add_low) - 10 * np.log10(add_mid))
        return np.array(out)

    def _kick_snare_threshold(self) -> float | None:
        """Fit the kick/snare spectral-balance split point for this track,
        using only clear, strong drum hits (1-D two-cluster k-means).
        Returns None when the track has no clear two-drum split."""
        if hasattr(self, "_ks_thr"):
            return self._ks_thr
        cand = np.union1d(self._peaks("kick", 0.3), self._peaks("snare", 0.3))
        bal = self._drum_balance(cand)
        thr = None
        if len(cand) >= 4:
            lo_c, hi_c = np.percentile(bal, 20), np.percentile(bal, 80)
            for _ in range(20):
                t = (lo_c + hi_c) / 2
                if not (bal < t).any() or not (bal >= t).any():
                    break
                lo_c, hi_c = bal[bal < t].mean(), bal[bal >= t].mean()
            # Only trust the split when the two groups are clearly different.
            if hi_c - lo_c >= 8:
                thr = (lo_c + hi_c) / 2
        self._ks_thr = thr
        return thr

    def hits(self, mode: str, sensitivity: float) -> np.ndarray:
        preset = PRESETS[mode]
        peaks = self._peaks(mode, sensitivity)
        if len(peaks) == 0:
            return np.array([])
        if mode in ("kick", "snare") and not (self.separate and preset["stem"]):
            thr = self._kick_snare_threshold()
            if thr is not None:
                # Keep a hit only if its spectral balance says it is this drum.
                is_kick = self._drum_balance(peaks) >= thr
                peaks = peaks[is_kick] if mode == "kick" else peaks[~is_kick]
            else:
                # Mix too ambiguous to fit a split: fall back to band dominance.
                env = self.band_envelope(mode)
                for rival, ratio in RIVALS.get(mode, []):
                    renv = self.band_envelope(rival)
                    own = np.array([self._local_max(env, p) for p in peaks])
                    other = np.array([self._local_max(renv, p) for p in peaks])
                    peaks = peaks[other < ratio * own]
        return librosa.frames_to_time(peaks, sr=self.sr, hop_length=HOP)

    @staticmethod
    def _local_max(env: np.ndarray, frame: int, w: int = 3) -> float:
        return float(env[max(0, frame - w): frame + w + 1].max())

    def beats(self, start_bpm: float | None) -> tuple[float, np.ndarray]:
        H, P, F = self._split()
        env = librosa.onset.onset_strength(S=librosa.amplitude_to_db(P, ref=np.max),
                                           sr=self.sr, hop_length=HOP)
        kwargs = dict(onset_envelope=env, sr=self.sr, hop_length=HOP, units="time")
        if start_bpm:
            kwargs["start_bpm"] = start_bpm
        tempo, beat_times = librosa.beat.beat_track(**kwargs)
        tempo = float(np.atleast_1d(tempo)[0])
        return tempo, np.asarray(beat_times)

    def downbeats(self, beat_times: np.ndarray, beats_per_bar: int,
                  shift: int = 0) -> np.ndarray:
        """Pick the bar phase whose beats carry the most kick/low-end energy.
        `shift` moves the result by whole beats if the guess is off."""
        if len(beat_times) < beats_per_bar * 2:
            return beat_times[shift % beats_per_bar::beats_per_bar]
        env = self.band_envelope("kick")
        fps = self.sr / HOP
        frames = np.clip((beat_times * fps).astype(int), 0, len(env) - 1)
        # Look a few frames around each beat so small timing offsets don't matter.
        w = 3
        strength = np.array([env[max(0, f - w): f + w + 1].max() for f in frames])
        scores = [strength[p::beats_per_bar].mean() for p in range(beats_per_bar)]
        phase = (int(np.argmax(scores)) + shift) % beats_per_bar
        return beat_times[phase::beats_per_bar]


def run_demucs(path: Path) -> dict[str, np.ndarray]:
    """Separate the track into drums / bass / vocals / other with demucs."""
    if shutil.which("demucs") is None:
        try:
            import demucs  # noqa: F401
        except ImportError:
            sys.exit("--separate needs demucs:  pip install demucs")
    out = Path(tempfile.mkdtemp(prefix="beatmarkers_"))
    print("Separating stems with demucs (this can take a minute)...")
    cmd = [sys.executable, "-m", "demucs", "-n", "htdemucs", "-o", str(out), str(path)]
    subprocess.run(cmd, check=True)
    stem_dir = next(out.rglob("drums.wav")).parent
    stems = {}
    for name in ("drums", "bass", "vocals", "other"):
        y, _ = librosa.load(str(stem_dir / f"{name}.wav"), sr=SR, mono=True)
        stems[name] = y
    shutil.rmtree(out, ignore_errors=True)
    return stems


# --------------------------------------------------------------------------
# Timecode helpers
# --------------------------------------------------------------------------

FPS_TABLE = {
    # fps: (timebase, ntsc, real fps)
    23.976: (24, True, 24000 / 1001),
    24: (24, False, 24.0),
    25: (25, False, 25.0),
    29.97: (30, True, 30000 / 1001),
    30: (30, False, 30.0),
    50: (50, False, 50.0),
    59.94: (60, True, 60000 / 1001),
    60: (60, False, 60.0),
}


def resolve_fps(value: float):
    for k, v in FPS_TABLE.items():
        if abs(k - value) < 0.01:
            return v
    raise SystemExit(f"Unsupported frame rate {value}. Use one of: "
                     + ", ".join(str(k) for k in FPS_TABLE))


def to_frame(t: float, real_fps: float) -> int:
    return int(round(t * real_fps))


def frames_to_tc(frames: int, timebase: int, start_hour: int = 0) -> str:
    """Non-drop timecode (Premiere reads NDF fine for marker placement)."""
    frames += start_hour * 3600 * timebase
    f = frames % timebase
    s = frames // timebase
    return f"{s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}:{f:02d}"


# --------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------

def write_csv(path: Path, markers: list[Marker], timebase: int, real_fps: float):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["name", "type", "seconds", "frame", "timecode"])
        for m in markers:
            fr = to_frame(m.time, real_fps)
            w.writerow([m.name, m.mode, f"{m.time:.4f}", fr, frames_to_tc(fr, timebase)])


def write_edl(path: Path, markers: list[Marker], title: str, clip_name: str,
              duration: float, timebase: int, ntsc: bool, real_fps: float,
              start_hour: int):
    total = max(1, to_frame(duration, real_fps))
    lines = [f"TITLE: {title}", "FCM: NON-DROP FRAME", ""]
    src_in = frames_to_tc(0, timebase)
    src_out = frames_to_tc(total, timebase)
    rec_in = frames_to_tc(0, timebase, start_hour)
    rec_out = frames_to_tc(total, timebase, start_hour)
    lines.append(f"001  AX       AA    C        {src_in} {src_out} {rec_in} {rec_out}")
    lines.append(f"* FROM CLIP NAME: {clip_name}")
    for m in markers:
        fr = to_frame(m.time, real_fps)
        tc = frames_to_tc(fr, timebase, start_hour)
        colour = EDL_COLOURS[m.mode]
        # Avid-style locator line; Resolve also reads this.
        lines.append(f"* LOC: {tc} {colour.upper():<7} {m.name}")
    lines.append("")
    path.write_text("\n".join(lines))


def write_fcpxml7(path: Path, markers: list[Marker], audio_path: Path,
                  seq_name: str, duration: float, timebase: int, ntsc: bool,
                  real_fps: float, sr: int, channels: int):
    """FCP7 (xmeml v4) sequence with the track on A1 and sequence markers."""
    total = max(1, to_frame(duration, real_fps))

    def rate(parent):
        r = ET.SubElement(parent, "rate")
        ET.SubElement(r, "timebase").text = str(timebase)
        ET.SubElement(r, "ntsc").text = "TRUE" if ntsc else "FALSE"
        return r

    root = ET.Element("xmeml", version="4")
    seq = ET.SubElement(root, "sequence", id="sequence-1")
    ET.SubElement(seq, "name").text = seq_name
    ET.SubElement(seq, "duration").text = str(total)
    rate(seq)
    tc = ET.SubElement(seq, "timecode")
    rate(tc)
    ET.SubElement(tc, "string").text = "00:00:00:00"
    ET.SubElement(tc, "frame").text = "0"
    ET.SubElement(tc, "displayformat").text = "NDF"

    media = ET.SubElement(seq, "media")
    video = ET.SubElement(media, "video")
    vfmt = ET.SubElement(ET.SubElement(video, "format"), "samplecharacteristics")
    rate(vfmt)
    ET.SubElement(vfmt, "width").text = "1920"
    ET.SubElement(vfmt, "height").text = "1080"
    ET.SubElement(vfmt, "pixelaspectratio").text = "square"
    ET.SubElement(video, "track")

    audio = ET.SubElement(media, "audio")
    afmt = ET.SubElement(ET.SubElement(audio, "format"), "samplecharacteristics")
    ET.SubElement(afmt, "depth").text = "16"
    ET.SubElement(afmt, "samplerate").text = str(sr)

    file_url = "file://localhost" + urllib.parse.quote(
        audio_path.resolve().as_posix() if os.name != "nt"
        else "/" + audio_path.resolve().as_posix())

    for ch in range(1, channels + 1):
        track = ET.SubElement(audio, "track")
        clip = ET.SubElement(track, "clipitem", id=f"clipitem-{ch}")
        ET.SubElement(clip, "name").text = audio_path.name
        ET.SubElement(clip, "enabled").text = "TRUE"
        ET.SubElement(clip, "duration").text = str(total)
        rate(clip)
        ET.SubElement(clip, "start").text = "0"
        ET.SubElement(clip, "end").text = str(total)
        ET.SubElement(clip, "in").text = "0"
        ET.SubElement(clip, "out").text = str(total)
        f = ET.SubElement(clip, "file", id="file-1")
        if ch == 1:
            ET.SubElement(f, "name").text = audio_path.name
            ET.SubElement(f, "pathurl").text = file_url
            rate(f)
            ET.SubElement(f, "duration").text = str(total)
            fm = ET.SubElement(f, "media")
            fa = ET.SubElement(fm, "audio")
            sc = ET.SubElement(fa, "samplecharacteristics")
            ET.SubElement(sc, "depth").text = "16"
            ET.SubElement(sc, "samplerate").text = str(sr)
            ET.SubElement(fa, "channelcount").text = str(channels)
        st = ET.SubElement(clip, "sourcetrack")
        ET.SubElement(st, "mediatype").text = "audio"
        ET.SubElement(st, "trackindex").text = str(ch)

    for m in markers:
        mk = ET.SubElement(seq, "marker")
        ET.SubElement(mk, "comment").text = f"{m.mode} @ {m.time:.3f}s"
        ET.SubElement(mk, "name").text = m.name
        fr = to_frame(m.time, real_fps)
        ET.SubElement(mk, "in").text = str(fr)
        ET.SubElement(mk, "out").text = "-1"

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def dedupe(times: np.ndarray, min_gap: float) -> np.ndarray:
    if len(times) == 0:
        return times
    times = np.sort(times)
    keep = [times[0]]
    for t in times[1:]:
        if t - keep[-1] >= min_gap:
            keep.append(t)
    return np.array(keep)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Create Premiere Pro markers on beats or instrument hits.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Examples:")[1] if "Examples:" in __doc__ else None)
    ap.add_argument("--version", action="version",
                    version=f"beatmarkers {__version__}")
    ap.add_argument("audio", type=Path, help="audio file (wav, mp3, aiff, flac, m4a...)")
    ap.add_argument("--mode", default="beats",
                    help="what to mark, comma-separated: " + ", ".join(ALL_MODES))
    ap.add_argument("--fps", type=float, default=25,
                    help="sequence frame rate (default 25)")
    ap.add_argument("--sensitivity", type=float, default=0.5,
                    help="0 = only strongest hits, 1 = everything (default 0.5)")
    ap.add_argument("--every", type=int, default=1,
                    help="keep every Nth marker (e.g. 2 = every other beat)")
    ap.add_argument("--beats-per-bar", type=int, default=4,
                    help="for downbeats (default 4)")
    ap.add_argument("--bar-shift", type=int, default=0,
                    help="if downbeats land on the wrong beat of the bar, move "
                         "them by this many beats (e.g. 1 or 2)")
    ap.add_argument("--bpm", type=float, default=None,
                    help="tempo hint if beat tracking picks half/double time")
    ap.add_argument("--start", type=float, default=0.0,
                    help="ignore anything before this time (seconds)")
    ap.add_argument("--end", type=float, default=None,
                    help="ignore anything after this time (seconds)")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="shift all markers by this many seconds (+ later / - earlier)")
    ap.add_argument("--separate", action="store_true",
                    help="use demucs stem separation first (more accurate for "
                         "vocals/bass/drums in dense mixes; slower)")
    ap.add_argument("--start-hour", type=int, default=1,
                    help="EDL record timecode start hour (default 01:00:00:00)")
    ap.add_argument("-o", "--out-dir", type=Path, default=None,
                    help="output folder (default: next to the audio file)")
    args = ap.parse_args(argv)

    if not args.audio.exists():
        sys.exit(f"File not found: {args.audio}")
    modes = [m.strip().lower() for m in args.mode.split(",") if m.strip()]
    bad = [m for m in modes if m not in ALL_MODES]
    if bad:
        sys.exit(f"Unknown mode(s): {', '.join(bad)}. Choose from: {', '.join(ALL_MODES)}")
    timebase, ntsc, real_fps = resolve_fps(args.fps)

    print(f"Loading {args.audio.name} ...")
    an = Analyzer(args.audio, separate=args.separate)
    print(f"  {an.duration:.1f}s")

    beat_times = None
    tempo = None
    markers: list[Marker] = []
    for mode in modes:
        if mode in ("beats", "downbeats"):
            if beat_times is None:
                tempo, beat_times = an.beats(args.bpm)
                print(f"  tempo ~ {tempo:.1f} BPM")
            times = beat_times if mode == "beats" else an.downbeats(beat_times, args.beats_per_bar,
                                                                     args.bar_shift)
        else:
            times = an.hits(mode, args.sensitivity)
        times = times[times >= args.start]
        if args.end is not None:
            times = times[times <= args.end]
        times = times[:: max(1, args.every)]
        times = times + args.offset
        times = times[(times >= 0) & (times <= an.duration)]
        # At most one marker per video frame per mode.
        times = dedupe(times, 1.0 / real_fps)
        print(f"  {mode:<10} {len(times):>5} markers")
        markers += [Marker(float(t), mode, i + 1) for i, t in enumerate(times)]

    markers.sort(key=lambda m: (m.time, ALL_MODES.index(m.mode)))
    if not markers:
        sys.exit("No markers found. Try a higher --sensitivity or another --mode.")

    out_dir = args.out_dir or args.audio.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.audio.stem + "_" + "-".join(modes)
    seq_name = f"{args.audio.stem} ({', '.join(modes)})"

    try:
        import soundfile as sf
        info = sf.info(str(args.audio))
        file_sr, channels = info.samplerate, min(2, info.channels)
    except Exception:
        file_sr, channels = 48000, 2

    xml_path = out_dir / f"{stem}_markers.xml"
    edl_path = out_dir / f"{stem}_markers.edl"
    csv_path = out_dir / f"{stem}_markers.csv"
    write_fcpxml7(xml_path, markers, args.audio, seq_name, an.duration,
                  timebase, ntsc, real_fps, file_sr, channels)
    write_edl(edl_path, markers, seq_name, args.audio.name, an.duration,
              timebase, ntsc, real_fps, args.start_hour)
    write_csv(csv_path, markers, timebase, real_fps)

    print("\nWrote:")
    for p in (xml_path, edl_path, csv_path):
        print(f"  {p}")
    print("\nPremiere: File > Import > the .xml  (creates a sequence with the markers)")


if __name__ == "__main__":
    main()
