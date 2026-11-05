#!/bin/bash
# Install Hammerspoon Shortcuts - version 1.0.0
# Double-click to install the Hammerspoon helpers for Effect Keys and,
# optionally, Cut In/Out. Safe to run again: it updates the scripts and
# never adds the same line to init.lua twice.
cd "$(dirname "$0")" || exit 1
HS="$HOME/.hammerspoon"
INIT="$HS/init.lua"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "=== Pensara Editing Tools: Hammerspoon shortcuts ==="
echo

if [ ! -d "/Applications/Hammerspoon.app" ]; then
  echo "Hammerspoon isn't installed yet."
  echo "Opening the Hammerspoon website. Install it, open it once,"
  echo "then double-click this file again."
  open "https://www.hammerspoon.org"
  echo; read -n 1 -s -r -p "Press any key to close."; exit 1
fi

mkdir -p "$HS"
touch "$INIT"

install_script () {   # $1 = source file, $2 = module name, $3 = variable name
  local src="$1" name="$2" var="$3" dest="$HS/$2.lua"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    cp "$dest" "$dest.backup-$STAMP"
    echo "  Backed up your old $name.lua to $name.lua.backup-$STAMP"
  fi
  cp "$src" "$dest"
  if ! grep -q "require(\"$name\")" "$INIT"; then
    printf '\n%s = require("%s")\n' "$var" "$name" >> "$INIT"
    echo "  Added $name to init.lua"
  fi
  echo "  Installed $name.lua"
}

echo "Effect Keys helper (needed for the Effect Keys panel):"
install_script "premiere/effect-keys/hammerspoon/effect_keys.lua" "effect_keys" "effectKeys"
echo

echo "Cut In/Out cuts the timeline at the In and Out points in one key press."
echo "Shortcuts: Cmd+K (all tracks) and Ctrl+Option+Shift+K (targeted tracks)."
echo "NOTE: while Premiere is in front, Cmd+K replaces Premiere's own Add Edit."
printf "Install Cut In/Out too? [y/N]: "; read -r ANSWER
case "$ANSWER" in
  y|Y|yes|YES) install_script "premiere/cut-in-out/cut_in_out.lua" "cut_in_out" "cutInOut" ;;
  *) echo "  Skipped Cut In/Out." ;;
esac

echo
echo "Done. Now:"
echo "  1. Click the Hammerspoon icon in the menu bar and choose Reload Config."
echo "  2. If macOS asks, allow Hammerspoon in System Settings >"
echo "     Privacy & Security > Accessibility."
echo; read -n 1 -s -r -p "Press any key to close."
