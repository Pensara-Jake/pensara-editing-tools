#!/bin/bash
# Double-click to install everything beatmarkers needs. Safe to run again.
cd "$(dirname "$0")" || exit 1
echo "=== Beat Markers installer ==="
echo

PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
         /usr/bin/python3; do
  if [ -x "$c" ] && "$c" -c "import sys; assert sys.version_info >= (3, 9)" 2>/dev/null; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo "Python isn't installed yet."
  echo "Opening the Python download page. Download it, run the installer,"
  echo "then double-click this Install file again."
  open "https://www.python.org/downloads/macos/"
  echo; read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

echo "Using Python: $PY ($("$PY" --version 2>&1))"
echo
if [ ! -x ".venv/bin/python" ]; then
  echo "Creating a private Python environment for this tool..."
  "$PY" -m venv .venv || { echo "Couldn't create the environment."; read -n 1 -s -r -p "Press any key to close."; exit 1; }
fi

echo "Installing librosa, soundfile and scipy (this takes a minute or two)..."
.venv/bin/python -m pip install --upgrade pip --quiet
.venv/bin/python -m pip install librosa soundfile scipy --quiet

echo
if .venv/bin/python -c "import librosa, soundfile, scipy" 2>/dev/null; then
  echo "SUCCESS: everything is installed."
  echo "To make markers, double-click 'Make Markers.command'."
  touch .install_ok
else
  echo "Something went wrong. Copy the text in this window and send it to Claude."
fi
echo; read -n 1 -s -r -p "Press any key to close."
