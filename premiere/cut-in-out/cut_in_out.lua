-- cut_in_out.lua - Hammerspoon shortcut for Premiere Pro
-- Version 1.0.0
--
-- Cuts the timeline at the In point and the Out point in one key press.
--   ⌘K    cut all tracks (replaces Premiere's own ⌘K Add Edit while Premiere is in front)
--   ⌃⌥⇧K  cut targeted tracks only
-- Only active while Premiere Pro is the front app.
--
-- It uses Premiere's own menu commands (Markers > Go to In / Go to Out,
-- Sequence > Add Edit), so it works even if you've changed Premiere's shortcuts.
-- The whole thing is two cuts, so it takes two Cmd+Z to undo.
--
-- Install: copy this file into ~/.hammerspoon/ and add this line to
-- ~/.hammerspoon/init.lua:
--     cutInOut = require("cut_in_out")
-- then choose "Reload Config" from the Hammerspoon menu bar icon.

local M = {}
M.VERSION = "1.0.0"

-- ================= SETTINGS =================
local ALL_TRACKS_KEY      = { { "cmd" }, "k" }
local TARGETED_TRACKS_KEY = { { "ctrl", "alt", "shift" }, "k" }

-- Premiere's Out point includes the Out frame, so the second cut goes one frame
-- after it. If the cut lands one frame too late for you, set this to false.
local INCLUDE_OUT_FRAME = true

local STEP_DELAY = 0.06   -- seconds between steps; raise to 0.15 if cuts go missing
-- ============================================

-- Menu items are found by pattern (case-insensitive), so small wording
-- differences between Premiere versions don't matter.
local MENU = {
  goIn       = { top = "^markers?$",  item = "^go to in" },
  goOut      = { top = "^markers?$",  item = "^go to out" },
  addEdit    = { top = "^sequence$",  item = "^add edit$" },
  addEditAll = { top = "^sequence$",  item = "^add edit to all tracks" },
}
local MENU_DUMP = os.getenv("HOME") .. "/.hammerspoon/cut_in_out_menus.txt"
local LOG_FILE  = os.getenv("HOME") .. "/.hammerspoon/cut_in_out_log.txt"

-- Keeps a short log of what happened on the last few presses.
local function log(msg)
  local line = os.date("%H:%M:%S ") .. msg
  print("cut_in_out: " .. msg)
  local f = io.open(LOG_FILE, "a")
  if f then f:write(line .. "\n") f:close() end
end

local function title(entry) return (entry and entry.AXTitle or ""):lower():gsub("%s+$", "") end

-- Searches the app's menu bar for an item; returns its full path, e.g. {"Markers","Go to In"}
local function findMenu(app, spec)
  local menus = app:getMenuItems()
  if not menus then return nil end
  local function walk(items, pathSoFar, depth)
    if not items or depth > 4 then return nil end
    for _, it in ipairs(items) do
      local t = it.AXTitle or ""
      if t ~= "" then
        local p = { table.unpack(pathSoFar) }; table.insert(p, t)
        if title(it):find(spec.item) then return p, it end
        local kids = it.AXChildren and it.AXChildren[1]
        local found, item = walk(kids, p, depth + 1)
        if found then return found, item end
      end
    end
  end
  for _, top in ipairs(menus) do
    if title(top):find(spec.top) then
      return walk(top.AXChildren and top.AXChildren[1], { top.AXTitle }, 1)
    end
  end
  return nil
end

-- Writes Premiere's menu names to a text file, to help fix a missing item.
local function dumpMenus(app)
  local menus = app:getMenuItems() or {}
  local out = {}
  local function walk(items, indent, depth)
    if not items or depth > 3 then return end
    for _, it in ipairs(items) do
      if (it.AXTitle or "") ~= "" then
        table.insert(out, indent .. it.AXTitle)
        walk(it.AXChildren and it.AXChildren[1], indent .. "    ", depth + 1)
      end
    end
  end
  walk(menus, "", 1)
  local f = io.open(MENU_DUMP, "w")
  if f then f:write(table.concat(out, "\n")) f:close() end
end

local function isPremiere(app)
  local id = app and app:bundleID() or ""
  return id:find("^com%.adobe%.PremierePro") ~= nil
end

local function anyModifierDown()
  local m = hs.eventtap.checkKeyboardModifiers()
  return m.cmd or m.alt or m.ctrl or m.shift
end

-- Runs a list of steps one after another with a short pause between them.
local function runSteps(steps, i)
  i = i or 1
  if i > #steps then return end
  local ok, err = steps[i]()
  if ok == false then
    hs.alert.show("Cut In/Out stopped: " .. (err or "step failed"), 2)
    return
  end
  hs.timer.doAfter(STEP_DELAY, function() runSteps(steps, i + 1) end)
end

local function cutInOut(allTracks)
  local app = hs.application.frontmostApplication()
  if not isPremiere(app) then
    log("ignored: front app is " .. tostring(app and app:bundleID()))
    return
  end

  log("---- pressed (" .. (allTracks and "all tracks" or "targeted tracks") .. ")")
  -- Hammerspoon needs Accessibility permission to use another app's menus.
  if not hs.accessibilityState() then
    log("NO ACCESSIBILITY PERMISSION")
    hs.accessibilityState(true) -- opens the macOS permission prompt
    hs.alert.show("Cut In/Out: allow Hammerspoon in System Settings → Privacy & Security → Accessibility, then try again", 5)
    return
  end

  local function menu(spec)
    return function()
      local name = spec.item:gsub("[%^%$]", "")
      local path, item = findMenu(app, spec)
      if not path then
        dumpMenus(app)
        log("NOT FOUND: " .. name)
        return false, "couldn't find the '" .. name .. "' menu item"
      end
      if item and item.AXEnabled == false then
        log("GREYED OUT: " .. table.concat(path, " > "))
        return false, table.concat(path, " > ") .. " is greyed out - click into the Timeline first"
      end
      local ok = app:selectMenuItem(path)
      log((ok and "OK: " or "SELECT FAILED: ") .. table.concat(path, " > "))
      if ok then return true end
      return false, "Premiere didn't accept " .. table.concat(path, " > ")
    end
  end
  local addEdit = menu(allTracks and MENU.addEditAll or MENU.addEdit)

  local steps = { menu(MENU.goIn), addEdit, menu(MENU.goOut) }
  if INCLUDE_OUT_FRAME then
    table.insert(steps, function() hs.eventtap.keyStroke({}, "right", 0, app) log("OK: step one frame") return true end)
  end
  table.insert(steps, addEdit)

  -- Wait until you've let go of the modifier keys so they don't mix with the arrow key.
  local waited = 0
  local function startWhenReleased()
    if anyModifierDown() and waited < 1.0 then
      waited = waited + 0.02
      hs.timer.doAfter(0.02, startWhenReleased)
    else
      runSteps(steps)
    end
  end
  startWhenReleased()
end

M.hotkeys = {
  hs.hotkey.new(ALL_TRACKS_KEY[1], ALL_TRACKS_KEY[2], function() cutInOut(true) end),
  hs.hotkey.new(TARGETED_TRACKS_KEY[1], TARGETED_TRACKS_KEY[2], function() cutInOut(false) end),
}

local function setActive(on)
  for _, hk in ipairs(M.hotkeys) do
    if on then hk:enable() else hk:disable() end
  end
end

M.watcher = hs.application.watcher.new(function(_, event, app)
  if event == hs.application.watcher.activated then setActive(isPremiere(app)) end
end):start()

setActive(isPremiere(hs.application.frontmostApplication()))

M.run = cutInOut -- for testing
return M
