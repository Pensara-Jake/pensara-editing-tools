-- effect_keys.lua - keyboard helper for the "Effect Keys" Premiere Pro panel
-- Version 1.0.0 (matches the Effect Keys panel manifest)
--
-- Catches the shortcuts you set up in the panel and hands them to the panel,
-- which applies the effect. Shortcuts only work while Premiere Pro is the
-- frontmost app; everywhere else your keys behave normally.
--
-- The panel and this script talk through a few small files in
-- /Users/Shared/EffectKeys (no network needed):
--   bindings.json  written by the panel: your shortcuts
--   presses.json   written here: recent key presses for the panel to act on
--   status.json    written here: "I'm running" + any shortcuts macOS refused
--
-- Install: copy this file into ~/.hammerspoon/ and add this line to
-- ~/.hammerspoon/init.lua:
--     effectKeys = require("effect_keys")
-- then choose "Reload Config" from the Hammerspoon menu bar icon.

local M = {}
M.VERSION = "1.0.0"

local DIR = EFFECT_KEYS_DIR or "/Users/Shared/EffectKeys"
local SHOW_ALERTS = false   -- true = flash the effect name on screen when pressed
local KEEP_PRESSES = 20

local bindings, version = {}, 0
local hotkeys, invalid, blocked = {}, {}, {}
local presses = {}
local premiereFront = false
local lastBindingsText = nil

-- ---------------------------------------------------------------- files
local function path(name) return DIR .. "/" .. name end

local function readFile(name)
  local f = io.open(path(name), "r")
  if not f then return nil end
  local s = f:read("a"); f:close()
  return s
end

-- Write to a temp file then rename, so the panel never reads half a file.
local function writeFile(name, text)
  local tmp = path("." .. name .. ".tmp")
  local f = io.open(tmp, "w")
  if not f then return false end
  f:write(text); f:close()
  return os.rename(tmp, path(name))
end

local function failedList()
  local out = {}
  for _, c in ipairs(invalid) do table.insert(out, c) end
  for _, c in ipairs(blocked) do table.insert(out, c) end
  return out
end

local function writeStatus()
  writeFile("status.json", hs.json.encode({
    alive = hs.timer.secondsSinceEpoch(),
    version = version,
    failed = failedList(),
  }))
end

-- ---------------------------------------------------------------- hotkeys
local function isPremiere(app)
  local id = app and app:bundleID() or ""
  return id:find("^com%.adobe%.PremierePro") ~= nil
end

local function splitCombo(combo)
  local parts = {}
  for p in combo:gmatch("[^+]+") do table.insert(parts, p) end
  local key = table.remove(parts)
  return parts, key
end

local function setActive(on)
  premiereFront = on
  blocked = {}
  for combo, hk in pairs(hotkeys) do
    if on then
      if not hk:enable() then table.insert(blocked, combo) end
    else
      hk:disable()
    end
  end
end

local function onPress(b)
  table.insert(presses, { combo = b.combo, t = hs.timer.secondsSinceEpoch() })
  while #presses > KEEP_PRESSES do table.remove(presses, 1) end
  writeFile("presses.json", hs.json.encode({ events = presses }))
  if SHOW_ALERTS then hs.alert.show(b.label, 0.6) end
end

local function rebuild()
  for _, hk in pairs(hotkeys) do hk:delete() end
  hotkeys, invalid = {}, {}
  for _, b in ipairs(bindings) do
    if type(b) == "table" and type(b.combo) == "string" then
      local mods, key = splitCombo(b.combo)
      local ok, hk = pcall(hs.hotkey.new, mods, key, function() onPress(b) end)
      if ok and hk then hotkeys[b.combo] = hk else table.insert(invalid, b.combo) end
    end
  end
  setActive(premiereFront)
  writeStatus()
end

-- Re-read bindings.json if the panel changed it.
local function loadBindings()
  local text = readFile("bindings.json")
  if not text or text == lastBindingsText then return end
  local ok, data = pcall(hs.json.decode, text)
  if not ok or type(data) ~= "table" then return end
  lastBindingsText = text
  bindings = data.bindings or {}
  version = data.version or 0
  rebuild()
end

-- ---------------------------------------------------------------- start
hs.fs.mkdir(DIR)
writeFile("presses.json", hs.json.encode({ events = {} }))

M.pathWatcher = hs.pathwatcher.new(DIR, function(paths)
  for _, p in ipairs(paths) do
    if p:find("bindings%.json$") then loadBindings() return end
  end
end):start()

M.heartbeat = hs.timer.doEvery(1, writeStatus)

M.appWatcher = hs.application.watcher.new(function(_, event, app)
  if event == hs.application.watcher.activated then
    setActive(isPremiere(app))
    writeStatus()
  end
end):start()

premiereFront = isPremiere(hs.application.frontmostApplication())
loadBindings()
writeStatus()

M._loadBindings = loadBindings -- for testing
return M
