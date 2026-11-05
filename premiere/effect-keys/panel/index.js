// Effect Keys - Premiere Pro UXP panel
// Assign keyboard shortcuts to video and audio effects.
//
// Premiere doesn't let plugins add keyboard shortcuts, so the keys are caught by a
// small Hammerspoon script (see the hammerspoon folder). The two talk through
// small files in /Users/Shared/EffectKeys. This panel:
//   - lets you pick an effect and a key combination, and saves the list to bindings.json
//   - checks presses.json every ~75 ms for shortcuts Hammerspoon caught
//   - applies that effect to the clips selected in the timeline

const ppro = require("premierepro");
const fs = require("fs");

const DIR = (typeof globalThis !== "undefined" && globalThis.EFFECT_KEYS_DIR) || "/Users/Shared/EffectKeys";
const POLL_MS = 75;
const STATUS_EVERY = 13;      // check Hammerspoon's status about once a second
const ALIVE_SECONDS = 4;      // Hammerspoon writes status every second
const PRESS_MAX_AGE = 2;      // ignore presses older than this

let effects = [];        // [{ kind: "video"|"audio", id, label }]
let bindings = [];       // [{ combo, kind, id, label }]
let chosen = null;       // effect picked in the search list
let connected = false;
let lastError = "";
let version = 0;               // bumps every time the shortcut list is saved
let lastPressT = Date.now() / 1000;
let lastFailed = "";
let logEl, statusEl;

function log(msg) {
  if (!logEl) return;
  const time = new Date().toTimeString().slice(0, 8);
  logEl.textContent = `${time}  ${msg}\n` + logEl.textContent.split("\n").slice(0, 30).join("\n");
}

function setStatus(ok, text) {
  connected = ok;
  statusEl.className = ok ? "ok" : "bad";
  statusEl.textContent = text;
}

// ------------------------------------------------------------ effect list
async function loadEffects() {
  const list = [];
  try {
    const matchNames = await ppro.VideoFilterFactory.getMatchNames();
    let displayNames = [];
    try { displayNames = await ppro.VideoFilterFactory.getDisplayNames(); } catch (e) {}
    const paired = displayNames.length === matchNames.length;
    matchNames.forEach((mn, i) => {
      const label = paired ? displayNames[i] : mn.replace(/^(AE|PR)\.ADBE\s*/, "");
      list.push({ kind: "video", id: mn, label });
    });
  } catch (e) { log("Couldn't read video effects: " + e.message); }
  try {
    const audio = await ppro.AudioFilterFactory.getDisplayNames();
    audio.forEach((dn) => list.push({ kind: "audio", id: dn, label: dn }));
  } catch (e) { log("Couldn't read audio effects: " + e.message); }
  list.sort((a, b) => a.label.localeCompare(b.label));
  effects = list;
}

function renderResults() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const box = document.getElementById("results");
  box.innerHTML = "";
  if (!q) return;
  const words = q.split(/\s+/);
  const hits = effects.filter((e) => words.every((w) => e.label.toLowerCase().includes(w))).slice(0, 40);
  if (!hits.length) { box.innerHTML = '<div class="result">No matches</div>'; return; }
  for (const e of hits) {
    const row = document.createElement("div");
    row.className = "result" + (chosen && chosen.id === e.id && chosen.kind === e.kind ? " chosen" : "");
    row.innerHTML = `<span></span><span class="kind">${e.kind}</span>`;
    row.firstChild.textContent = e.label;
    row.addEventListener("click", () => {
      chosen = e;
      document.getElementById("chosen").textContent = `Effect: ${e.label} (${e.kind})`;
      renderResults();
      document.getElementById("combo").focus();
    });
    box.appendChild(row);
  }
}

// ------------------------------------------------------------ key capture
// Converts a key press into Hammerspoon's format, e.g. "ctrl+alt+1"
const CODE_MAP = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
  Space: "space", Enter: "return", Tab: "tab", Escape: "escape", Backspace: "delete",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

function keyFromEvent(e) {
  const code = e.code || "";
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return "pad" + m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return "f" + m[1];
  if (CODE_MAP[code]) return CODE_MAP[code];
  return null;
}

function comboFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("cmd");
  return [...mods, key].join("+");
}

const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];
const MOD_ALIASES = { control: "ctrl", "⌃": "ctrl", option: "alt", opt: "alt", "⌥": "alt", "⇧": "shift", command: "cmd", "⌘": "cmd" };

// Tidies a typed combination like "Ctrl + Option + 1" into "ctrl+alt+1"
function normaliseCombo(text) {
  const parts = text.toLowerCase().split(/\s*\+\s*/).map((p) => p.trim()).filter(Boolean).map((p) => MOD_ALIASES[p] || p);
  const mods = MOD_ORDER.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !MOD_ORDER.includes(p));
  if (keys.length !== 1) return null;
  return [...mods, keys[0]].join("+");
}

function prettyCombo(combo) {
  const sym = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
  return combo.split("+").map((p) => sym[p] || p.toUpperCase()).join("");
}

// ------------------------------------------------------------ bindings
function renderBindings(failed = []) {
  const table = document.getElementById("bindings");
  table.innerHTML = "";
  if (!bindings.length) {
    table.innerHTML = '<tr><td style="opacity:0.6">None yet</td></tr>';
    return;
  }
  bindings.forEach((b, i) => {
    const tr = document.createElement("tr");
    const bad = failed.includes(b.combo);
    tr.innerHTML = `<td class="key${bad ? " fail" : ""}"></td><td></td><td class="del"><span class="x" title="Remove">✕</span></td>`;
    tr.children[0].textContent = prettyCombo(b.combo) + (bad ? " (in use)" : "");
    tr.children[1].textContent = `${b.label}${b.kind === "audio" ? " (audio)" : ""}`;
    tr.querySelector(".x").addEventListener("click", async () => {
      bindings.splice(i, 1);
      await pushBindings();
    });
    table.appendChild(tr);
  });
}

// ------------------------------------------------------------ shared files
async function readJSON(name) {
  const text = await fs.readFile(`${DIR}/${name}`, { encoding: "utf-8" });
  return JSON.parse(text);
}

async function pushBindings() {
  try {
    try { await fs.mkdir(DIR); } catch (e) {} // already there
    version = Date.now();
    await fs.writeFile(`${DIR}/bindings.json`, JSON.stringify({ version, bindings }), { encoding: "utf-8" });
    renderBindings();
    return true;
  } catch (e) {
    renderBindings();
    log(`Couldn't save shortcuts to ${DIR}: ${e.message || e}`);
    return false;
  }
}

async function pullBindings() {
  try {
    const data = await readJSON("bindings.json");
    bindings = Array.isArray(data.bindings) ? data.bindings : [];
    version = data.version || 0;
  } catch (e) { /* no shortcuts saved yet */ }
  renderBindings();
}

async function checkStatus() {
  try {
    const st = await readJSON("status.json");
    const alive = Date.now() / 1000 - Number(st.alive || 0) < ALIVE_SECONDS;
    if (alive && !connected) { setStatus(true, "Helper connected - shortcuts active"); lastError = ""; }
    if (!alive) setStatus(false, "Helper not running - start Hammerspoon");
    if (alive && st.version === version) {
      const failed = Array.isArray(st.failed) ? st.failed : [];
      const key = failed.join(",");
      if (key !== lastFailed) {
        lastFailed = key;
        renderBindings(failed);
        if (failed.length) log(`macOS wouldn't register: ${failed.map(prettyCombo).join(", ")} - another app is using it. Pick a different combination.`);
      }
    }
  } catch (e) {
    setStatus(false, "Helper not running - start Hammerspoon");
    const msg = (e && (e.message || String(e))) || "unknown error";
    if (msg !== lastError) { lastError = msg; log("Waiting for Hammerspoon (" + msg + ")"); }
  }
}

async function addBinding() {
  const comboInput = document.getElementById("combo");
  const combo = normaliseCombo(comboInput.value);
  if (!chosen) { log("Search for an effect and click it first."); return; }
  if (!combo) { log('Press a key combination in the box, or type one like "ctrl+alt+1".'); return; }
  if (!/[+]/.test(combo) && !/^f\d+$/.test(combo)) {
    log("Use at least one modifier (⌃ ⌥ ⇧ ⌘) unless it's an F-key, or you won't be able to type that key anywhere in Premiere.");
    return;
  }
  const existing = bindings.find((b) => b.combo === combo);
  if (existing) { log(`${prettyCombo(combo)} is already set to ${existing.label}.`); return; }

  bindings.push({ combo, kind: chosen.kind, id: chosen.id, label: chosen.label });
  if (await pushBindings()) log(`${prettyCombo(combo)} → ${chosen.label}`);
  comboInput.value = "";
}

// ------------------------------------------------------------ applying an effect
async function applyEffect(b) {
  const project = await ppro.Project.getActiveProject();
  const seq = project && (await project.getActiveSequence());
  if (!seq) { log("No sequence open."); return; }

  const items = await (await seq.getSelection()).getTrackItems();
  const targets = items.filter((t) =>
    b.kind === "audio" ? t instanceof ppro.AudioClipTrackItem : t instanceof ppro.VideoClipTrackItem
  );
  if (!targets.length) { log(`${b.label}: select ${b.kind} clips in the timeline first.`); return; }

  const work = [];
  for (const t of targets) {
    try {
      const comp = b.kind === "audio"
        ? await ppro.AudioFilterFactory.createComponentByDisplayName(b.id, t)
        : await ppro.VideoFilterFactory.createComponent(b.id);
      work.push({ chain: await t.getComponentChain(), comp });
    } catch (e) {
      log(`Couldn't create ${b.label}: ${e.message}`);
      return;
    }
  }

  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((ca) => {
      for (const w of work) ca.addAction(w.chain.createAppendComponentAction(w.comp));
    }, `Apply ${b.label}`);
  });
  log(ok ? `${b.label} → ${work.length} clip(s)` : `Premiere refused to apply ${b.label}.`);
}

// ------------------------------------------------------------ watching for key presses
let busy = false;
let tick = 0;
async function poll() {
  try {
    if (tick++ % STATUS_EVERY === 0) await checkStatus();
    if (connected) {
      let data = null;
      try { data = await readJSON("presses.json"); } catch (e) { /* mid-write, try next time */ }
      const events = (data && Array.isArray(data.events)) ? data.events : [];
      const now = Date.now() / 1000;
      for (const ev of events) {
        if (!(ev.t > lastPressT)) continue;
        lastPressT = ev.t;
        if (now - ev.t > PRESS_MAX_AGE) continue;
        const b = bindings.find((x) => x.combo === ev.combo);
        if (b && !busy) {
          busy = true;
          try { await applyEffect(b); } catch (e) { log("Error: " + e.message); }
          busy = false;
        }
      }
    }
  } catch (e) {
    log("Error: " + (e.message || e));
  }
  setTimeout(poll, POLL_MS);
}

// ------------------------------------------------------------ UI wiring
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", async () => {
    logEl = document.getElementById("log");
    statusEl = document.getElementById("status");

    document.getElementById("search").addEventListener("input", renderResults);

    const comboInput = document.getElementById("combo");
    comboInput.addEventListener("keydown", (e) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const combo = comboFromEvent(e);
      if (!combo) return; // let the user type it instead
      const hasMod = e.ctrlKey || e.altKey || e.metaKey;
      const isF = /^f\d+$/.test(combo.split("+").pop());
      if (hasMod || isF) {
        e.preventDefault();
        comboInput.value = combo;
      }
    });
    comboInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBinding(); });
    document.getElementById("add").addEventListener("click", addBinding);

    renderBindings();
    await pullBindings();
    await loadEffects();
    log(`Loaded ${effects.length} effects.`);
    poll();
  });
}

if (typeof module !== "undefined") {
  // for testing outside Premiere
  module.exports = {
    comboFromEvent, normaliseCombo, prettyCombo, applyEffect, pushBindings, pullBindings, poll, checkStatus,
    _init: (els) => { logEl = els.log; statusEl = els.status; },
    _bindings: (b) => { if (b) bindings = b; return bindings; },
  };
}
