# Pensara Editing Tools

Plugins and scripts for Premiere Pro, After Effects and Photoshop, built in-house at Pensara.

To install, get a copy of this repository: in GitHub Desktop choose **File > Clone Repository**, or download it from GitHub as a ZIP. Then follow the steps below.

## What's included

| Tool | App | Version | What it does |
|---|---|---|---|
| [Effect Keys](premiere/effect-keys) | Premiere Pro 25.6+ (Mac) | 1.0.0 | Keyboard shortcuts for any effect. Press the key and the effect goes on the selected clips. |
| [Split Stacker](premiere/split-stacker) | Premiere Pro 25.6+ | 1.0.0 | Restacks the two halves of 16:9 horizontal split screen clips (left/right) into a vertical version (top/bottom) for social aspect ratios. |
| [beatmarkers](premiere/beatmarkers) | Premiere Pro (also Resolve, Avid) | 1.0.0 | Puts a marker on every beat, or every kick, snare, hi-hat, bass or vocal hit in a song. |
| [Cut In/Out](premiere/cut-in-out) | Premiere Pro (Mac) | 1.0.0 | Cuts the timeline at the In and Out points in one key press. |
| [Logo Layout Panel](after-effects/logo-layout) | After Effects | 4.0.0 | Sizes and spaces a set of logos evenly inside the safe zone. |
| [Trim Logos](after-effects/logo-layout) | Photoshop | 1.0.0 | Crops white or transparent borders off a folder of logos, ready for the Logo Layout Panel. |

## Installing

### Premiere panels (Effect Keys, Split Stacker)
1. In Premiere: **Settings > Plugins**, tick **Enable developer mode**, restart Premiere.
2. Install **UXP Developer Tools** from the Creative Cloud app and open it.
3. Click **Add Plugin**, choose the panel's `manifest.json` (`premiere/effect-keys/panel` or `premiere/split-stacker`), then click **Load**.
4. In Premiere: **Window > UXP Plugins**, then choose the panel and dock it.

If a panel is missing after Premiere restarts, click **Load** on it again in UXP Developer Tools.

### Hammerspoon shortcuts (Effect Keys helper, Cut In/Out)
Effect Keys needs [Hammerspoon](https://www.hammerspoon.org) to catch its shortcuts. Cut In/Out runs entirely in Hammerspoon.
1. Install Hammerspoon and open it once.
2. Double-click **Install Hammerspoon Shortcuts.command** in this folder.
3. Choose **Reload Config** from the Hammerspoon menu bar icon.

Cut In/Out is optional and the installer asks first, because its Cmd+K shortcut replaces Premiere's own Add Edit while Premiere is in front.

### beatmarkers
1. Double-click **premiere/beatmarkers/Install.command** (once; it installs Python packages into the tool's own folder).
2. Double-click **Make Markers.command**, drag in a song and answer the questions.
3. In Premiere: **File > Import** the file ending `_markers.xml`.

### Logo Layout Panel and Trim Logos
See **Logo Layout Tools - Read Me.pdf** in `after-effects/logo-layout`.

## Shortcuts

All of these only work while Premiere Pro is the front app.

| Shortcut | Action | Tool |
|---|---|---|
| Cmd+K | Cut all tracks at In and one frame after Out | Cut In/Out |
| Ctrl+Option+Shift+K | Same cut, targeted tracks only | Cut In/Out |
| Your choice | Apply the chosen effect to the selected clips | Effect Keys (set in the panel) |

## For maintainers

- Every change to a tool gets a version bump, in the tool's file (manifest `version`, `__version__`, or the version line at the top of the script) and in `CHANGELOG.md`.
- Use [semantic versioning](https://semver.org): fixes bump the last number (1.0.1), new features the middle (1.1.0), changes that break existing use the first (2.0.0).
