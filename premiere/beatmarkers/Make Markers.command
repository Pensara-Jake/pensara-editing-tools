#!/bin/bash
# Double-click to create Premiere markers for a song.
cd "$(dirname "$0")" || exit 1
if [ ! -x ".venv/bin/python" ]; then
  echo "Not installed yet. Double-click 'Install.command' first."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi

echo "=== Beat Markers ==="
echo
echo "Drag your song file into this window, then press Enter:"
read -r SONG
# Dragging adds quotes or backslash-escapes; undo them.
SONG="${SONG%\"}"; SONG="${SONG#\"}"; SONG="${SONG%\'}"; SONG="${SONG#\'}"
SONG="$(printf '%s' "$SONG" | sed -e 's/[[:space:]]*$//' -e 's/\\\(.\)/\1/g')"
if [ ! -f "$SONG" ]; then
  echo "Couldn't find that file: $SONG"
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi

echo
echo "What should get a marker? Type the numbers, separated by commas (e.g. 3,4)."
echo "  1 = every beat"
echo "  2 = first beat of each bar"
echo "  3 = kick drum"
echo "  4 = snare / clap"
echo "  5 = hi-hats"
echo "  6 = bass notes"
echo "  7 = vocals / melody"
echo "  8 = every hit of anything"
printf "Choice [1]: "; read -r CHOICE
[ -z "$CHOICE" ] && CHOICE=1
MODES=""
for n in $(echo "$CHOICE" | tr ',' ' '); do
  case "$n" in
    1) m=beats;; 2) m=downbeats;; 3) m=kick;; 4) m=snare;;
    5) m=hihat;; 6) m=bass;; 7) m=vocals;; 8) m=onsets;;
    *) echo "Ignoring '$n'"; continue;;
  esac
  MODES="${MODES:+$MODES,}$m"
done
[ -z "$MODES" ] && MODES=beats

echo
echo "Sequence frame rate? (23.976, 24, 25, 29.97, 30, 50, 59.94, 60)"
printf "Frame rate [25]: "; read -r FPS
[ -z "$FPS" ] && FPS=25

echo
echo "How many markers? 1 = only the strongest hits, 2 = normal, 3 = catch everything"
printf "Amount [2]: "; read -r AMT
case "$AMT" in 1) SENS=0.25;; 3) SENS=0.8;; *) SENS=0.5;; esac

echo
.venv/bin/python beatmarkers.py "$SONG" --mode "$MODES" --fps "$FPS" --sensitivity "$SENS"
echo
echo "In Premiere: File > Import, and pick the file ending in _markers.xml"
echo "(it's in the same folder as your song)."
open -R "$SONG" 2>/dev/null
echo; read -n 1 -s -r -p "Press any key to close."
