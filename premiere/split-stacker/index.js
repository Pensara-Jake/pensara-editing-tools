// Split Stacker - Premiere Pro UXP panel
// Restacks the SELECTED clips of a side-by-side split screen into a top/bottom split
// in a vertical (9x16) sequence. Left shot -> top half, right shot -> bottom half
// (switchable). Each clip is scaled to fill its half and re-cropped, keeping the
// part of the shot your Crop left visible centred.

const ppro = require("premierepro");

const FALLBACK_MEDIA_SIZE = [1920, 1080]; // only used if the clip's frame size can't be read

// ---------------------------------------------------------------- helpers
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function findComponent(chain, test) {
  const n = chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = chain.getComponentAtIndex(i);
    let mn = "", dn = "";
    try { mn = await c.getMatchName(); } catch (e) {}
    try { dn = await c.getDisplayName(); } catch (e) {}
    if (test(mn, dn)) return c;
  }
  return null;
}
const isMotion = (mn, dn) => mn === "AE.ADBE Motion" || dn === "Motion";
const isCrop = (mn, dn) => /(^|[.\s])Crop$/.test(mn) || dn === "Crop";

function getParam(comp, name, fallbackIndex) {
  if (!comp) return null;
  const n = comp.getParamCount();
  for (let i = 0; i < n; i++) {
    const p = comp.getParam(i);
    if (p.displayName === name) return p;
  }
  return fallbackIndex < n ? comp.getParam(fallbackIndex) : null;
}

async function readValue(param) {
  const kf = await param.getStartValue();
  return kf.value.value;
}

async function mediaSize(projectItem) {
  try {
    const cols = JSON.parse(await ppro.Metadata.getProjectColumnsMetadata(projectItem));
    for (const c of cols) {
      if (/video info/i.test(c.ColumnName || "")) {
        const m = /(\d+)\s*x\s*(\d+)/.exec(c.ColumnValue || "");
        if (m) return [Number(m[1]), Number(m[2])];
      }
    }
  } catch (e) {}
  try {
    const xml = await ppro.Metadata.getProjectMetadata(projectItem);
    const m = /VideoInfo>\s*(\d+)\s*x\s*(\d+)/.exec(xml);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch (e) {}
  return null;
}

async function cropMatchName() {
  const names = await ppro.VideoFilterFactory.getMatchNames();
  if (names.indexOf("AE.ADBE Crop") !== -1) return "AE.ADBE Crop";
  return names.find((n) => /(^|[.\s])Crop$/.test(n)) || null;
}

// Position/Anchor values may come back normalised (0-1) or in pixels.
const looksNormalised = (pt) => Math.abs(pt[0]) <= 1.5 && Math.abs(pt[1]) <= 1.5;

// ---------------------------------------------------------------- main
async function restack(opts, log) {
  const project = await ppro.Project.getActiveProject();
  if (!project) { log("No project open."); return; }
  const seq = await project.getActiveSequence();
  if (!seq) { log("Open your 9x16 sequence first."); return; }

  const frame = await seq.getFrameSize();
  const W = frame.width, H = frame.height;
  if (W >= H) {
    log(`Active sequence is ${W}x${H}, not vertical.\nDuplicate the edit, set the copy to 1080x1920 in Sequence Settings, select the split clips there and try again.`);
    return;
  }

  const selection = await seq.getSelection();
  const all = await selection.getTrackItems();
  const clips = all.filter((t) => t instanceof ppro.VideoClipTrackItem);
  if (!clips.length) { log("No video clips selected."); return; }

  // ---- 1. Read every selected clip
  const items = [];
  for (const clip of clips) {
    const name = await clip.getName();
    const start = (await clip.getStartTime()).seconds;
    const end = (await clip.getEndTime()).seconds;
    const where = `${start.toFixed(2)}s "${name}"`;

    try { if (await clip.isAdjustmentLayer()) { log(`Skipped (adjustment layer): ${where}`); continue; } } catch (e) {}

    const projectItem = await clip.getProjectItem();
    const chain = await clip.getComponentChain();
    const motion = await findComponent(chain, isMotion);
    if (!motion) { log(`Skipped (no Motion): ${where}`); continue; }

    const pPos = getParam(motion, "Position", 0);
    const pScale = getParam(motion, "Scale", 1);
    const pUni = getParam(motion, "Uniform Scale", 3);
    const pAnchor = getParam(motion, "Anchor Point", 5);

    if (pPos.isTimeVarying() || pScale.isTimeVarying()) { log(`Skipped (keyframed Position/Scale): ${where}`); continue; }
    try { if (pUni && (await readValue(pUni)) === false) { log(`Skipped (non-uniform scale): ${where}`); continue; } } catch (e) {}

    const crop = await findComponent(chain, isCrop);
    let cropVals = [0, 0, 0, 0];
    if (crop) {
      const ps = [getParam(crop, "Left", 0), getParam(crop, "Top", 1), getParam(crop, "Right", 2), getParam(crop, "Bottom", 3)];
      if (ps.some((p) => p.isTimeVarying())) { log(`Skipped (keyframed Crop): ${where}`); continue; }
      cropVals = [];
      for (const p of ps) cropVals.push(Number(await readValue(p)) / 100);
    }

    let size = projectItem ? await mediaSize(projectItem) : null;
    if (!size) { size = FALLBACK_MEDIA_SIZE; log(`Note (media size unknown, assumed ${size[0]}x${size[1]}): ${where}`); }

    const pos = await readValue(pPos);
    const anchor = pAnchor ? await readValue(pAnchor) : null;

    items.push({ clip, name, where, start, end, chain, motion, crop, cropVals, size, pos, anchor });
  }
  if (!items.length) { log("Nothing to restack."); return; }

  // ---- 2. Left or right? Compare clips that overlap in time; fall back to frame centre.
  for (const it of items) {
    const group = items.filter((o) => o.start < it.end && o.end > it.start);
    const xs = group.map((o) => o.pos[0]);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    if (hi - lo > 1e-6) {
      it.isLeft = it.pos[0] < (lo + hi) / 2;
    } else {
      it.isLeft = looksNormalised(it.pos) ? it.pos[0] < 0.5 : it.pos[0] < W / 2;
    }
  }

  // ---- 3. Add a Crop effect where one is missing
  const needCrop = items.filter((it) => !it.crop);
  if (needCrop.length) {
    const mn = await cropMatchName();
    if (!mn) {
      log("Couldn't find the Crop effect - add Crop to these clips manually and run again.");
    } else {
      const comps = [];
      for (let k = 0; k < needCrop.length; k++) comps.push(await ppro.VideoFilterFactory.createComponent(mn));
      project.lockedAccess(() => {
        project.executeTransaction((ca) => {
          needCrop.forEach((it, k) => ca.addAction(it.chain.createAppendComponentAction(comps[k])));
        }, "Split Stacker: add Crop");
      });
      for (const it of needCrop) {
        it.chain = await it.clip.getComponentChain();
        it.motion = await findComponent(it.chain, isMotion);
        it.crop = await findComponent(it.chain, isCrop);
      }
    }
  }

  // ---- 4. Work out the new framing
  const halfH = H / 2;
  const topBox = [0, 0, W, halfH], bottomBox = [0, halfH, W, H];
  const edits = [];
  for (const it of items) {
    const box = (it.isLeft === opts.leftOnTop) ? topBox : bottomBox;
    const [w, h] = it.size;
    const [cL, cT, cR, cB] = it.cropVals;
    const uc = (cL + (1 - cR)) / 2;   // centre of the visible part, 0-1 across the source
    const vc = (cT + (1 - cB)) / 2;

    const [bx0, by0, bx1, by1] = box;
    const s = Math.max((bx1 - bx0) / w, (by1 - by0) / h) * opts.zoom;
    const dw = w * s, dh = h * s;
    const left = clamp((bx0 + bx1) / 2 - uc * dw, bx1 - dw, bx0);
    const top = clamp((by0 + by1) / 2 - vc * dh, by1 - dh, by0);

    const cx = left + dw / 2, cy = top + dh / 2;
    const normPos = looksNormalised(it.pos);
    edits.push({
      it,
      pos: normPos ? [cx / W, cy / H] : [cx, cy],
      anchor: it.anchor ? (looksNormalised(it.anchor) ? [0.5, 0.5] : [w / 2, h / 2]) : null,
      scale: s * 100,
      crop: [
        clamp((bx0 - left) / dw * 100, 0, 100),
        clamp((by0 - top) / dh * 100, 0, 100),
        clamp((left + dw - bx1) / dw * 100, 0, 100),
        clamp((top + dh - by1) / dh * 100, 0, 100),
      ],
      half: box === topBox ? "top" : "bottom",
    });
  }

  // ---- 5. Apply everything in one undoable step
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((ca) => {
      for (const e of edits) {
        const mot = e.it.motion, crop = e.it.crop;
        const pPos = getParam(mot, "Position", 0);
        const pScale = getParam(mot, "Scale", 1);
        const pAnchor = getParam(mot, "Anchor Point", 5);

        if (e.anchor && pAnchor) ca.addAction(pAnchor.createSetValueAction(pAnchor.createKeyframe(new ppro.PointF(e.anchor[0], e.anchor[1])), true));
        ca.addAction(pPos.createSetValueAction(pPos.createKeyframe(new ppro.PointF(e.pos[0], e.pos[1])), true));
        ca.addAction(pScale.createSetValueAction(pScale.createKeyframe(e.scale), true));

        if (crop) {
          const names = ["Left", "Top", "Right", "Bottom"];
          names.forEach((nm, k) => {
            const p = getParam(crop, nm, k);
            ca.addAction(p.createSetValueAction(p.createKeyframe(e.crop[k]), true));
          });
        }
      }
    }, "Split Stacker: restack split screen");
  });

  const done = edits.length;
  log(ok ? `Restacked ${done} clip(s):` : "Premiere rejected the change - nothing was modified.");
  if (ok) edits.forEach((e) => log(`  ${e.half.padEnd(6)} ${e.it.where}`));
}

// ---------------------------------------------------------------- UI
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const logEl = document.getElementById("log");
    const log = (m) => { logEl.textContent += m + "\n"; };
    document.getElementById("run").addEventListener("click", async () => {
      logEl.textContent = "";
      const zoom = Math.max(1, Number(document.getElementById("zoom").value) || 1);
      const leftOnTop = !!document.getElementById("leftOnTop").checked;
      try { await restack({ zoom, leftOnTop }, log); }
      catch (err) { log("Error: " + (err && err.message ? err.message : err)); }
    });
  });
}

if (typeof module !== "undefined") module.exports = { restack };
