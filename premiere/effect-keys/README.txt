Effect Keys - keyboard shortcuts for effects in Premiere Pro (Mac)

Version 1.0.0

Two parts:
  - the Effect Keys panel (panel folder), which applies the effects
  - effect_keys.lua (hammerspoon folder), which catches the keys

Quickest install: double-click "Install Hammerspoon Shortcuts.command" at the
top of the repository for steps 2-4,. The panel still loads through UXP
Developer Tools (step 5).

ONE-TIME SETUP
1. Install Hammerspoon (free) from https://www.hammerspoon.org and open it.
   (Or in Terminal: brew install --cask hammerspoon)
2. Copy hammerspoon/effect_keys.lua into the folder ~/.hammerspoon/
   (In Finder: Go > Go to Folder..., type ~/.hammerspoon)
3. Open ~/.hammerspoon/init.lua in a text editor (create it if it isn't there)
   and add this line:
       effectKeys = require("effect_keys")
4. Click the Hammerspoon icon in the menu bar > Reload Config.
   Tip: in Hammerspoon Preferences, tick "Launch Hammerspoon at login".
5. Load the panel: in UXP Developer Tools click Add Plugin, choose
   panel/manifest.json, then Load. In Premiere: Window > UXP Plugins > Effect Keys.
6. Dock the panel somewhere in your workspace. It has to be open for shortcuts
   to work. The bar at the top turns green when it can see Hammerspoon.

ADDING A SHORTCUT
1. Type in the search box (e.g. "gaussian") and click the effect.
2. Click the key box and press the combination, e.g. Ctrl+Option+1.
   Or type it: ctrl+alt+1  (modifiers: ctrl, alt, shift, cmd)
3. Click Add.

USING IT
Select clips in the timeline and press the shortcut. Video effects go on the
selected video clips, audio effects on the selected audio clips. Each press is
one undo step.

GOOD TO KNOW
- Shortcuts only work while Premiere is the front app. Everywhere else your keys
  behave normally.
- While Premiere is in front, an Effect Keys shortcut takes priority over a
  Premiere shortcut on the same keys. Ctrl+Option+number or Ctrl+Option+letter
  combinations are usually free.
- If macOS won't give a combination to Hammerspoon (another app owns it), it
  shows in red in the list. Remove it and pick another.
- Shortcuts are saved by Hammerspoon, so they survive restarts.
