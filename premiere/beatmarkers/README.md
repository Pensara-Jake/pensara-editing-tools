# beatmarkers

Puts a marker on every beat, or every hit of a chosen instrument, in a music
track, and writes files Premiere Pro can import.

## Setup (once)

Requires Python 3.9+.

```
pip install librosa soundfile scipy
```

Optional, for better separation of vocals/bass/drums in busy mixes:

```
pip install demucs
```

## Use

```
python beatmarkers.py song.wav                              # every beat
python beatmarkers.py song.wav --mode kick,snare            # kick and snare hits
python beatmarkers.py song.mp3 --mode downbeats --fps 25    # first beat of each bar
python beatmarkers.py song.wav --mode beats --every 2       # every other beat
python beatmarkers.py song.wav --mode vocals --separate     # vocal onsets via demucs
```

Each run writes three files next to the audio (or into `-o folder`):

| File | What it's for |
|---|---|
| `*_markers.xml` | **Premiere Pro.** File → Import. Creates a sequence with the track on the audio tracks and one sequence marker per hit. |
| `*_markers.edl` | DaVinci Resolve / Avid. Markers are written as `* LOC:` locators. Premiere ignores markers in EDLs, so use the XML for Premiere. |
| `*_markers.csv` | Name, type, seconds, frame and timecode for every marker. |

Markers are named by type and count (`Beat 12`, `Kick 4`, `Snare 9`...), so
mixed modes stay readable in Premiere's Markers panel.

To get the markers onto an existing edit, import the XML, then copy the music
clip with its markers into your sequence, or nest the imported sequence.

## Modes

| Mode | Marks | How |
|---|---|---|
| `beats` | the steady beat grid | tempo tracking on the percussive part |
| `downbeats` | beat 1 of each bar | beat grid + which beat carries the most low end |
| `kick` | bass drum | 30–150 Hz attacks, then classified by spectral balance |
| `snare` | snare / clap | 180–4000 Hz attacks, same classifier |
| `hihat` | hats / cymbals | 7–16 kHz attacks |
| `bass` | bass-note starts | 35–250 Hz, harmonic part only |
| `vocals` / `melody` | lead / vocal note starts | 250–4000 Hz, harmonic part only |
| `onsets` | any transient | full spectrum |

## Options

| Option | Default | Meaning |
|---|---|---|
| `--fps` | 25 | sequence frame rate: 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 |
| `--sensitivity` | 0.5 | 0 = only strong hits, 1 = everything incl. ghost notes |
| `--every N` | 1 | keep every Nth marker |
| `--bar-shift N` | 0 | downbeats on the wrong beat? move them N beats |
| `--beats-per-bar` | 4 | 3 for waltz time, etc. |
| `--bpm` | auto | tempo hint if beats come out at half or double speed |
| `--start` / `--end` | whole file | only mark a section (seconds) |
| `--offset` | 0 | nudge all markers (seconds, can be negative) |
| `--separate` | off | split stems with demucs first; slower, better in dense mixes |
| `-o` | next to audio | output folder |

## Accuracy

Tested on a synthetic 120 BPM mix, then on a harder version with varied hit
velocities, a sustained pad, reverb and background noise. F-score within 50 ms
at the default sensitivity:

| | clean | with reverb + noise |
|---|---|---|
| beats | 0.99 | 1.00 |
| kick | 1.00 | 1.00 |
| snare | 1.00 | 1.00 |
| hihat | 1.00 | 0.88 (0.99 at `--sensitivity 0.8`) |
| bass | 1.00 | 1.00 |
| vocals/melody | 0.81 | 0.81 |
| downbeats | 0.95 | needed `--bar-shift 2` |

Real recordings are messier. If a mode misses hits, raise `--sensitivity`; if
it marks too much, lower it. Vocals and melody are the hardest without stem
separation, so try `--separate` for those.
