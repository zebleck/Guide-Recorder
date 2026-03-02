const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const exportFinalBtn = document.getElementById("exportFinalBtn");
const saveProjectBtn = document.getElementById("saveProjectBtn");
const loadProjectInput = document.getElementById("loadProjectInput");
const loadVideoInput = document.getElementById("loadVideoInput");
const statusEl = document.getElementById("status");
const playPauseBtn = document.getElementById("playPauseBtn");
const seekBar = document.getElementById("seekBar");
const timeLabel = document.getElementById("timeLabel");

const videoEl = document.getElementById("previewVideo");
const canvas = document.getElementById("overlayCanvas");
const ctx = canvas.getContext("2d");
const previewStageEl = document.getElementById("previewStage");
const keyPill = document.getElementById("liveKeyPill");

const addZoomBtn = document.getElementById("addZoomBtn");
const addTextBtn = document.getElementById("addTextBtn");

const zoomList = document.getElementById("zoomList");
const textList = document.getElementById("textList");

const zoomStart = document.getElementById("zoomStart");
const zoomEnd = document.getElementById("zoomEnd");
const zoomScale = document.getElementById("zoomScale");
const zoomEase = document.getElementById("zoomEase");

const textStart = document.getElementById("textStart");
const textEnd = document.getElementById("textEnd");
const textX = document.getElementById("textX");
const textY = document.getElementById("textY");
const textValue = document.getElementById("textValue");
const cursorOffsetXInput = document.getElementById("cursorOffsetX");
const cursorOffsetYInput = document.getElementById("cursorOffsetY");
const cursorTextureInput = document.getElementById("cursorTextureInput");
const cursorTextureClearBtn = document.getElementById("cursorTextureClearBtn");
const cursorHotspotXInput = document.getElementById("cursorHotspotX");
const cursorHotspotYInput = document.getElementById("cursorHotspotY");
const cursorPreviewCanvas = document.getElementById("cursorPreviewCanvas");
const cursorPreviewCtx = cursorPreviewCanvas.getContext("2d");

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let recordingUrl = "";
let importedVideoUrl = "";
let recordStartMs = 0;
let rafId = 0;
let isSeeking = false;
let previewFrameCanvas = null;
let previewFrameCtx = null;
let composeCanvas = null;
let composeCtx = null;
const PREVIEW_EXPORT_VIDEO_BITRATE = 32000000;
const CURSOR_PREFS_STORAGE_KEY = "guide-recorder.cursor-prefs.v1";
let cursorTextureImage = null;
let cursorPreviewMap = null;

const project = {
  recordedBlob: null,
  recordedMimeType: "video/webm",
  durationSec: 0,
  events: [],
  zooms: [],
  texts: [],
  cursorOffsetX: 0,
  cursorOffsetY: 0,
  captureBounds: null,
  cursorTextureDataUrl: "",
  cursorTextureName: "",
  cursorHotspotX: 0,
  cursorHotspotY: 0,
};

const pointerState = {
  x: 0,
  y: 0,
  inFrame: false,
  xPct: 0,
  yPct: 0,
};

const buttonDownSince = {
  0: null,
  2: null,
};

function setStatus(msg) {
  statusEl.textContent = msg;
}

function refreshActionButtons() {
  downloadBtn.disabled = !project.recordedBlob;
  exportFinalBtn.disabled = !videoEl.src;
  playPauseBtn.disabled = !videoEl.src;
  seekBar.disabled = !videoEl.src;
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function syncPlaybackUi() {
  const dur = Number(videoEl.duration || 0);
  const cur = Number(videoEl.currentTime || 0);

  if (!isSeeking) {
    if (dur > 0) seekBar.value = String(Math.round((cur / dur) * 1000));
    else seekBar.value = "0";
  }
  timeLabel.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
  playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
}

function nowMs() {
  return performance.now();
}

function recMs() {
  return nowMs() - recordStartMs;
}

function pushEvent(evt) {
  if (!recordStartMs) return;
  project.events.push({
    t: recMs(),
    ...evt,
  });
}

function formatSec(ms) {
  return (ms / 1000).toFixed(2);
}

function fitCanvasToVideo() {
  const rect = videoEl.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
}

function syncPreviewStageAspect() {
  const vw = Number(videoEl.videoWidth || 0);
  const vh = Number(videoEl.videoHeight || 0);
  if (!previewStageEl || vw <= 0 || vh <= 0) return;
  previewStageEl.style.aspectRatio = `${vw} / ${vh}`;
}

function videoContentRect() {
  const cw = canvas.width || 1;
  const ch = canvas.height || 1;
  const vw = videoEl.videoWidth || cw;
  const vh = videoEl.videoHeight || ch;
  const contentAspect = vw / vh;
  const canvasAspect = cw / ch;

  let width = cw;
  let height = ch;
  if (canvasAspect > contentAspect) {
    height = ch;
    width = height * contentAspect;
  } else {
    width = cw;
    height = width / contentAspect;
  }

  return {
    x: (cw - width) / 2,
    y: (ch - height) / 2,
    width,
    height,
  };
}

function clearOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDefaultCursor(renderCtx) {
  renderCtx.beginPath();
  renderCtx.moveTo(0, 0);
  renderCtx.lineTo(0, 20);
  renderCtx.lineTo(5.6, 14.8);
  renderCtx.lineTo(10.2, 25.2);
  renderCtx.lineTo(13.4, 23.8);
  renderCtx.lineTo(8.8, 13.6);
  renderCtx.lineTo(17.2, 13.6);
  renderCtx.closePath();
  renderCtx.fillStyle = "#ffffff";
  renderCtx.fill();

  renderCtx.strokeStyle = "rgba(0,0,0,0.9)";
  renderCtx.lineWidth = 1.1;
  renderCtx.stroke();
}

function clampHotspotToImageBounds() {
  if (!cursorTextureImage) {
    project.cursorHotspotX = 0;
    project.cursorHotspotY = 0;
    return;
  }
  const maxX = Math.max(0, cursorTextureImage.width - 1);
  const maxY = Math.max(0, cursorTextureImage.height - 1);
  project.cursorHotspotX = Math.max(0, Math.min(maxX, Math.round(Number(project.cursorHotspotX || 0))));
  project.cursorHotspotY = Math.max(0, Math.min(maxY, Math.round(Number(project.cursorHotspotY || 0))));
}

function syncCursorHotspotInputs() {
  cursorHotspotXInput.value = String(Math.round(Number(project.cursorHotspotX || 0)));
  cursorHotspotYInput.value = String(Math.round(Number(project.cursorHotspotY || 0)));
}

function renderCursorPreviewCanvas() {
  const w = cursorPreviewCanvas.width;
  const h = cursorPreviewCanvas.height;
  cursorPreviewCtx.clearRect(0, 0, w, h);
  cursorPreviewCtx.fillStyle = "#0d111a";
  cursorPreviewCtx.fillRect(0, 0, w, h);
  cursorPreviewMap = null;

  if (!cursorTextureImage) {
    cursorPreviewCtx.save();
    cursorPreviewCtx.translate(24, 24);
    drawDefaultCursor(cursorPreviewCtx);
    cursorPreviewCtx.restore();
    return;
  }

  const maxW = w - 16;
  const maxH = h - 16;
  const scale = Math.min(maxW / cursorTextureImage.width, maxH / cursorTextureImage.height, 1);
  const drawW = cursorTextureImage.width * scale;
  const drawH = cursorTextureImage.height * scale;
  const dx = (w - drawW) / 2;
  const dy = (h - drawH) / 2;

  cursorPreviewCtx.drawImage(cursorTextureImage, dx, dy, drawW, drawH);
  const hx = dx + (project.cursorHotspotX / Math.max(1, cursorTextureImage.width)) * drawW;
  const hy = dy + (project.cursorHotspotY / Math.max(1, cursorTextureImage.height)) * drawH;
  cursorPreviewCtx.strokeStyle = "#47d7ac";
  cursorPreviewCtx.lineWidth = 1.2;
  cursorPreviewCtx.beginPath();
  cursorPreviewCtx.moveTo(hx - 6, hy);
  cursorPreviewCtx.lineTo(hx + 6, hy);
  cursorPreviewCtx.moveTo(hx, hy - 6);
  cursorPreviewCtx.lineTo(hx, hy + 6);
  cursorPreviewCtx.stroke();

  cursorPreviewMap = {
    dx,
    dy,
    drawW,
    drawH,
  };
}

function persistCursorPrefsToLocalStorage() {
  try {
    const payload = {
      cursorTextureDataUrl: project.cursorTextureDataUrl || "",
      cursorTextureName: project.cursorTextureName || "",
      cursorHotspotX: Number(project.cursorHotspotX || 0),
      cursorHotspotY: Number(project.cursorHotspotY || 0),
    };
    window.localStorage.setItem(CURSOR_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

async function loadCursorPrefsFromLocalStorage() {
  let raw = "";
  try {
    raw = window.localStorage.getItem(CURSOR_PREFS_STORAGE_KEY) || "";
  } catch {
    return;
  }
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    project.cursorHotspotX = Number(data.cursorHotspotX || 0);
    project.cursorHotspotY = Number(data.cursorHotspotY || 0);
    project.cursorTextureName = String(data.cursorTextureName || "");
    syncCursorHotspotInputs();
    await loadCursorTextureFromDataUrl(
      String(data.cursorTextureDataUrl || ""),
      project.cursorTextureName
    );
  } catch {
    // Ignore malformed stored data.
  }
}

async function loadCursorTextureFromDataUrl(dataUrl, name = "") {
  if (!dataUrl) {
    cursorTextureImage = null;
    project.cursorTextureDataUrl = "";
    project.cursorTextureName = "";
    project.cursorHotspotX = 0;
    project.cursorHotspotY = 0;
    syncCursorHotspotInputs();
    renderCursorPreviewCanvas();
    persistCursorPrefsToLocalStorage();
    return;
  }

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  cursorTextureImage = img;
  project.cursorTextureDataUrl = dataUrl;
  project.cursorTextureName = name || project.cursorTextureName || "cursor";
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
}

async function readFileAsDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed reading cursor texture file"));
    reader.readAsDataURL(file);
  });
}

function ensurePreviewFrameBuffer(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!previewFrameCanvas) {
    previewFrameCanvas = document.createElement("canvas");
    previewFrameCtx = previewFrameCanvas.getContext("2d");
  }
  if (previewFrameCanvas.width !== w) previewFrameCanvas.width = w;
  if (previewFrameCanvas.height !== h) previewFrameCanvas.height = h;
  return { canvas: previewFrameCanvas, ctx: previewFrameCtx, width: w, height: h };
}

function ensureComposeBuffer(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!composeCanvas) {
    composeCanvas = document.createElement("canvas");
    composeCtx = composeCanvas.getContext("2d");
  }
  if (composeCanvas.width !== w) composeCanvas.width = w;
  if (composeCanvas.height !== h) composeCanvas.height = h;
  return { canvas: composeCanvas, ctx: composeCtx, width: w, height: h };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function toUnitRatio(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Accept both [0..1] and legacy [0..100] percentage formats.
  if (Math.abs(value) > 1.5) return clamp01(value / 100);
  return clamp01(value);
}

function eventRatio(evt, axis) {
  const ratioKey = axis === "x" ? "xPct" : "yPct";
  const direct = toUnitRatio(evt?.[ratioKey]);
  if (direct != null) return direct;

  const bounds = project.captureBounds;
  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return null;
  }

  const screenKey = axis === "x" ? "xScreen" : "yScreen";
  const fallbackKey = axis === "x" ? "x" : "y";
  const raw = Number.isFinite(evt?.[screenKey]) ? evt[screenKey] : evt?.[fallbackKey];
  if (!Number.isFinite(raw)) return null;

  const base = axis === "x" ? bounds.x : bounds.y;
  const size = axis === "x" ? bounds.width : bounds.height;
  return clamp01((raw - base) / size);
}

function drawClickBursts(currentMs, zoomViewport, contentRect) {
  const life = 460;
  for (const evt of project.events) {
    if (evt.type !== "mouse_down") continue;
    const age = currentMs - evt.t;
    if (age < 0 || age > life) continue;
    const rawPos = eventToCanvasPosition(evt);
    const pos = rawPos
      ? mapPointThroughViewportInRect(rawPos, zoomViewport, contentRect)
      : null;
    if (!pos) continue;
    const p = age / life;
    const radius = 12 + p * 34;
    const alpha = 1 - p;

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    const color =
      evt.button === 2
        ? `rgba(249,95,98,${alpha})`
        : evt.button === 1
          ? `rgba(255,200,0,${alpha})`
          : `rgba(0,255,102,${alpha})`;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function drawHeldButtons(currentMs) {
  const holds = [];
  const heldSince = activeHoldsAt(currentMs);
  if (heldSince[0] != null) holds.push({ label: "L HOLD", downAt: heldSince[0] });
  if (heldSince[2] != null) holds.push({ label: "R HOLD", downAt: heldSince[2] });
  if (!holds.length) return;

  let y = 30;
  for (const hold of holds) {
    const dur = Math.max(0, currentMs - hold.downAt);
    const text = `${hold.label}: ${formatSec(dur)}s`;

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(12, y - 16, 120, 20);
    ctx.fillStyle = "#f3f5fa";
    ctx.font = "12px Segoe UI";
    ctx.fillText(text, 16, y);
    y += 24;
  }
}

function drawTextOverlays(currentMs) {
  const tSec = currentMs / 1000;
  for (const t of project.texts) {
    if (tSec < t.startSec || tSec > t.endSec) continue;

    const x = (t.xPct / 100) * canvas.width;
    const y = (t.yPct / 100) * canvas.height;

    const pad = 8;
    ctx.font = "bold 22px Segoe UI";
    const w = ctx.measureText(t.value).width + pad * 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
    ctx.fillRect(x - pad, y - 24, w, 34);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(t.value, x, y);
  }
}

function activeZoomAt(currentMs) {
  const tSec = currentMs / 1000;
  const z = project.zooms.find((item) => tSec >= item.startSec && tSec <= item.endSec);
  if (!z) return null;

  const easeMs = Math.max(0, z.easeMs || 0);
  const inMs = (tSec - z.startSec) * 1000;
  const outMs = (z.endSec - tSec) * 1000;

  let factor = z.scale;
  if (easeMs > 0 && inMs < easeMs) {
    const p = inMs / easeMs;
    factor = 1 + (z.scale - 1) * p;
  }
  if (easeMs > 0 && outMs < easeMs) {
    const p = outMs / easeMs;
    factor = 1 + (z.scale - 1) * p;
  }
  return factor;
}

function applyZoom(zoomViewport) {
  if (!zoomViewport || zoomViewport.factor <= 1.001) {
    videoEl.style.transformOrigin = "0px 0px";
    videoEl.style.transform = "matrix(1,0,0,1,0,0)";
    return;
  }

  // Deterministic mapping: x' = f*(x - sx), y' = f*(y - sy).
  // Using matrix avoids transform-order ambiguity between scale/translate.
  const f = zoomViewport.factor;
  const tx = -f * zoomViewport.sx;
  const ty = -f * zoomViewport.sy;
  videoEl.style.transformOrigin = "0px 0px";
  videoEl.style.transform = `matrix(${f},0,0,${f},${tx},${ty})`;
}

function updateLiveKeyPill(currentMs) {
  const keyDown = lastKeyDownAt(currentMs);
  if (!keyDown || currentMs - keyDown.t > 900) {
    keyPill.classList.add("hidden");
    return;
  }
  const keyLabel = keyDown.key ?? (keyDown.keycode != null ? `KC${keyDown.keycode}` : "Unknown");
  keyPill.textContent = `Key: ${keyLabel}`;
  keyPill.classList.remove("hidden");
}

function eventToCanvasPosition(evt) {
  const rect = videoContentRect();
  const ox = Number(project.cursorOffsetX || 0);
  const oy = Number(project.cursorOffsetY || 0);
  const xr = eventRatio(evt, "x");
  const yr = eventRatio(evt, "y");
  if (xr != null && yr != null) {
    return {
      x: rect.x + xr * rect.width + ox,
      y: rect.y + yr * rect.height + oy,
    };
  }
  if (typeof evt.x === "number" && typeof evt.y === "number") {
    return { x: evt.x + ox, y: evt.y + oy };
  }
  return null;
}

function pointerAt(currentMs) {
  let latest = null;
  for (const evt of project.events) {
    if (evt.t > currentMs) break;
    if (evt.type !== "mouse_move" && evt.type !== "mouse_down" && evt.type !== "mouse_up") continue;
    if (evt.inFrame === false) continue;
    const pos = eventToCanvasPosition(evt);
    if (!pos) continue;
    latest = pos;
  }

  if (!latest) {
    const rect = videoContentRect();
    return { inFrame: false, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  return { inFrame: true, x: latest.x, y: latest.y };
}

function activeHoldsAt(currentMs) {
  const heldSince = { 0: null, 2: null };
  for (const evt of project.events) {
    if (evt.t > currentMs) break;
    if (evt.type === "mouse_down" && (evt.button === 0 || evt.button === 2)) {
      heldSince[evt.button] = evt.t;
    }
    if (evt.type === "mouse_up" && (evt.button === 0 || evt.button === 2)) {
      heldSince[evt.button] = null;
    }
  }
  return heldSince;
}

function lastKeyDownAt(currentMs) {
  for (let i = project.events.length - 1; i >= 0; i -= 1) {
    const evt = project.events[i];
    if (evt.t > currentMs) continue;
    if (evt.type === "key_down") return evt;
    if (evt.t < currentMs - 1000) break;
  }
  return null;
}

function exportEventToPosition(evt, width, height) {
  const ox = Number(project.cursorOffsetX || 0);
  const oy = Number(project.cursorOffsetY || 0);
  const xr = eventRatio(evt, "x");
  const yr = eventRatio(evt, "y");
  if (xr != null && yr != null) {
    return {
      x: xr * width + ox,
      y: yr * height + oy,
    };
  }
  if (typeof evt.x === "number" && typeof evt.y === "number") {
    return { x: evt.x + ox, y: evt.y + oy };
  }
  return null;
}

function pointerAtForExport(currentMs, width, height) {
  let latest = null;
  for (const evt of project.events) {
    if (evt.t > currentMs) break;
    if (evt.type !== "mouse_move" && evt.type !== "mouse_down" && evt.type !== "mouse_up") continue;
    if (evt.inFrame === false) continue;
    const pos = exportEventToPosition(evt, width, height);
    if (!pos) continue;
    latest = pos;
  }

  if (!latest) return { inFrame: false, x: width / 2, y: height / 2 };
  return { inFrame: true, x: latest.x, y: latest.y };
}

function drawCursorOn(renderCtx, pointer) {
  if (!pointer?.inFrame) return;
  renderCtx.save();
  renderCtx.translate(pointer.x, pointer.y);
  renderCtx.shadowColor = "rgba(0,0,0,0.45)";
  renderCtx.shadowBlur = 3;
  renderCtx.shadowOffsetX = 1;
  renderCtx.shadowOffsetY = 1;
  if (cursorTextureImage) {
    const hx = Number(project.cursorHotspotX || 0);
    const hy = Number(project.cursorHotspotY || 0);
    renderCtx.drawImage(cursorTextureImage, -hx, -hy);
  } else {
    drawDefaultCursor(renderCtx);
  }
  renderCtx.restore();
}

function drawClickBurstsOn(renderCtx, currentMs, width, height, zoomViewport) {
  const life = 460;
  for (const evt of project.events) {
    if (evt.type !== "mouse_down") continue;
    const age = currentMs - evt.t;
    if (age < 0 || age > life) continue;

    const rawPos = exportEventToPosition(evt, width, height);
    const pos = rawPos ? mapPointThroughViewport(rawPos, zoomViewport, width, height) : null;
    if (!pos) continue;

    const p = age / life;
    const radius = 12 + p * 34;
    const alpha = 1 - p;

    renderCtx.beginPath();
    renderCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    renderCtx.lineWidth = 2;
    const color =
      evt.button === 2
        ? `rgba(249,95,98,${alpha})`
        : evt.button === 1
          ? `rgba(255,200,0,${alpha})`
          : `rgba(0,255,102,${alpha})`;
    renderCtx.strokeStyle = color;
    renderCtx.stroke();
  }
}

function drawHeldButtonsOn(renderCtx, currentMs) {
  const holds = [];
  const heldSince = activeHoldsAt(currentMs);
  if (heldSince[0] != null) holds.push({ label: "L HOLD", downAt: heldSince[0] });
  if (heldSince[2] != null) holds.push({ label: "R HOLD", downAt: heldSince[2] });
  if (!holds.length) return;

  let y = 30;
  for (const hold of holds) {
    const dur = Math.max(0, currentMs - hold.downAt);
    const text = `${hold.label}: ${formatSec(dur)}s`;

    renderCtx.fillStyle = "rgba(0,0,0,0.6)";
    renderCtx.fillRect(12, y - 16, 120, 20);
    renderCtx.fillStyle = "#f3f5fa";
    renderCtx.font = "12px Segoe UI";
    renderCtx.fillText(text, 16, y);
    y += 24;
  }
}

function drawTextOverlaysOn(renderCtx, currentMs, width, height) {
  const tSec = currentMs / 1000;
  for (const t of project.texts) {
    if (tSec < t.startSec || tSec > t.endSec) continue;

    const x = (t.xPct / 100) * width;
    const y = (t.yPct / 100) * height;
    const pad = 8;

    renderCtx.font = "bold 22px Segoe UI";
    const w = renderCtx.measureText(t.value).width + pad * 2;
    renderCtx.fillStyle = "rgba(0, 0, 0, 0.68)";
    renderCtx.fillRect(x - pad, y - 24, w, 34);
    renderCtx.fillStyle = "#ffffff";
    renderCtx.fillText(t.value, x, y);
  }
}

function drawKeyPillOn(renderCtx, currentMs, width) {
  const keyDown = lastKeyDownAt(currentMs);
  if (!keyDown || currentMs - keyDown.t > 900) return;

  const keyLabel = keyDown.key ?? (keyDown.keycode != null ? `KC${keyDown.keycode}` : "Unknown");
  const text = `Key: ${keyLabel}`;

  renderCtx.font = "14px Segoe UI";
  const textW = renderCtx.measureText(text).width;
  const pillW = textW + 22;
  const x = width - pillW - 12;
  const y = 12;

  renderCtx.fillStyle = "rgba(0,0,0,0.72)";
  renderCtx.strokeStyle = "#566181";
  renderCtx.lineWidth = 1;
  renderCtx.beginPath();
  renderCtx.roundRect(x, y, pillW, 30, 15);
  renderCtx.fill();
  renderCtx.stroke();

  renderCtx.fillStyle = "#f3f5fa";
  renderCtx.fillText(text, x + 11, y + 20);
}

function getZoomViewportAt(currentMs, pointer, width, height) {
  const factor = activeZoomAt(currentMs) || 1;
  if (factor <= 1.001) {
    return {
      factor: 1,
      sx: 0,
      sy: 0,
      sw: width,
      sh: height,
    };
  }

  const px = pointer?.inFrame ? pointer.x : width / 2;
  const py = pointer?.inFrame ? pointer.y : height / 2;
  const sw = width / factor;
  const sh = height / factor;
  let sx = px - sw / 2;
  let sy = py - sh / 2;

  sx = Math.max(0, Math.min(width - sw, sx));
  sy = Math.max(0, Math.min(height - sh, sy));

  return {
    factor,
    sx,
    sy,
    sw,
    sh,
  };
}

function mapPointThroughViewport(point, zoomViewport, width, height) {
  if (!zoomViewport || zoomViewport.factor <= 1.001) return point;
  const mapped = {
    x: ((point.x - zoomViewport.sx) * width) / zoomViewport.sw,
    y: ((point.y - zoomViewport.sy) * height) / zoomViewport.sh,
  };
  return {
    x: Math.max(0, Math.min(width, mapped.x)),
    y: Math.max(0, Math.min(height, mapped.y)),
  };
}

function drawZoomedVideoOn(renderCtx, sourceVideo, zoomViewport, width, height) {
  renderCtx.imageSmoothingEnabled = true;
  renderCtx.imageSmoothingQuality = "high";
  if (!zoomViewport || zoomViewport.factor <= 1.001) {
    renderCtx.drawImage(sourceVideo, 0, 0, width, height);
    return;
  }
  renderCtx.drawImage(
    sourceVideo,
    zoomViewport.sx,
    zoomViewport.sy,
    zoomViewport.sw,
    zoomViewport.sh,
    0,
    0,
    width,
    height
  );
}

function mapPointThroughViewportInRect(point, zoomViewport, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const local = {
    x: point.x - rect.x,
    y: point.y - rect.y,
  };
  const mapped = mapPointThroughViewport(local, zoomViewport, rect.width, rect.height);
  return {
    x: rect.x + mapped.x,
    y: rect.y + mapped.y,
  };
}

function drawZoomedVideoInRect(renderCtx, sourceVideo, zoomViewport, rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  renderCtx.imageSmoothingEnabled = true;
  renderCtx.imageSmoothingQuality = "high";
  const srcW = Math.max(1, Number(sourceVideo?.videoWidth || 0));
  const srcH = Math.max(1, Number(sourceVideo?.videoHeight || 0));
  if (srcW <= 1 || srcH <= 1) return;

  if (!zoomViewport || zoomViewport.factor <= 1.001) {
    renderCtx.drawImage(sourceVideo, rect.x, rect.y, rect.width, rect.height);
    return;
  }

  const scaleX = srcW / rect.width;
  const scaleY = srcH / rect.height;
  const sx = zoomViewport.sx * scaleX;
  const sy = zoomViewport.sy * scaleY;
  const sw = zoomViewport.sw * scaleX;
  const sh = zoomViewport.sh * scaleY;
  renderCtx.drawImage(sourceVideo, sx, sy, sw, sh, rect.x, rect.y, rect.width, rect.height);
}

function renderExportFrame(renderCtx, sourceVideo, currentMs, width, height) {
  const pointer = pointerAtForExport(currentMs, width, height);
  const zoomViewport = getZoomViewportAt(currentMs, pointer, width, height);
  const composed = ensureComposeBuffer(width, height);

  // Pass 1: compose full frame without zoom.
  composed.ctx.clearRect(0, 0, width, height);
  composed.ctx.fillStyle = "#000";
  composed.ctx.fillRect(0, 0, width, height);
  drawZoomedVideoOn(composed.ctx, sourceVideo, null, width, height);
  drawClickBurstsOn(composed.ctx, currentMs, width, height, null);
  drawCursorOn(composed.ctx, pointer);
  drawHeldButtonsOn(composed.ctx, currentMs);
  drawTextOverlaysOn(composed.ctx, currentMs, width, height);
  drawKeyPillOn(composed.ctx, currentMs, width);

  // Pass 2: apply zoom to whole composed frame (video + overlays together).
  renderCtx.clearRect(0, 0, width, height);
  renderCtx.fillStyle = "#000";
  renderCtx.fillRect(0, 0, width, height);
  drawZoomedVideoOn(renderCtx, composed.canvas, zoomViewport, width, height);
}

function preferredExportMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

async function waitForMediaEvent(media, eventName) {
  await new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Media event failed: ${eventName}`));
    };
    const cleanup = () => {
      media.removeEventListener(eventName, onOk);
      media.removeEventListener("error", onErr);
    };
    media.addEventListener(eventName, onOk, { once: true });
    media.addEventListener("error", onErr, { once: true });
  });
}

async function exportFinalVideo() {
  if (!videoEl.src) {
    setStatus("Load a video first before exporting final output.");
    return;
  }

  exportFinalBtn.disabled = true;
  setStatus("Exporting final video with effects...");

  let exportVideo = null;
  let exportStream = null;
  let raf = 0;

  try {
    exportVideo = document.createElement("video");
    exportVideo.src = videoEl.currentSrc || videoEl.src;
    exportVideo.playsInline = true;
    exportVideo.preload = "auto";
    exportVideo.volume = 0;

    if (exportVideo.readyState < 1) {
      await waitForMediaEvent(exportVideo, "loadedmetadata");
    }

    const width = Math.max(2, exportVideo.videoWidth || 0);
    const height = Math.max(2, exportVideo.videoHeight || 0);
    if (width < 2 || height < 2) {
      throw new Error("Invalid video dimensions for export");
    }

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext("2d");

    const fps = 60;
    const canvasStream = exportCanvas.captureStream(fps);

    let audioTracks = [];
    try {
      const audioStream = exportVideo.captureStream();
      audioTracks = audioStream.getAudioTracks();
    } catch {
      audioTracks = [];
    }

    exportStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

    const mimeType = preferredExportMimeType();
    const recorder = mimeType
      ? new MediaRecorder(exportStream, { mimeType, videoBitsPerSecond: PREVIEW_EXPORT_VIDEO_BITRATE })
      : new MediaRecorder(exportStream, { videoBitsPerSecond: PREVIEW_EXPORT_VIDEO_BITRATE });

    const exportChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) exportChunks.push(e.data);
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    let done = false;
    const drawLoop = () => {
      const currentMs = Math.max(0, exportVideo.currentTime * 1000);
      renderExportFrame(exportCtx, exportVideo, currentMs, width, height);

      if (exportVideo.ended) {
        done = true;
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      raf = requestAnimationFrame(drawLoop);
    };

    renderExportFrame(exportCtx, exportVideo, 0, width, height);
    recorder.start(100);
    await exportVideo.play();
    raf = requestAnimationFrame(drawLoop);

    await stopped;
    if (!done) cancelAnimationFrame(raf);

    const blob = new Blob(exportChunks, {
      type: recorder.mimeType || "video/webm",
    });
    downloadBlob(blob, "guide-recorder-final.webm");
    setStatus("Final video exported with effects.");
  } catch (err) {
    setStatus(`Export failed: ${err.message || String(err)}`);
  } finally {
    cancelAnimationFrame(raf);
    if (exportVideo) {
      try {
        exportVideo.pause();
        exportVideo.removeAttribute("src");
        exportVideo.load();
      } catch {
        // ignore
      }
    }
    if (exportStream) {
      exportStream.getTracks().forEach((t) => t.stop());
    }
    exportFinalBtn.disabled = false;
  }
}
function renderOverlay() {
  if (!videoEl.src) return;

  fitCanvasToVideo();
  const currentMs = Math.max(0, videoEl.currentTime * 1000);
  const frame = ensurePreviewFrameBuffer(canvas.width, canvas.height);

  renderExportFrame(frame.ctx, videoEl, currentMs, frame.width, frame.height);
  clearOverlay();
  ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);

  rafId = requestAnimationFrame(renderOverlay);
}

function startRenderLoop() {
  cancelAnimationFrame(rafId);
  keyPill.classList.add("hidden");
  videoEl.style.visibility = "hidden";
  rafId = requestAnimationFrame(renderOverlay);
}

function stopRenderLoop() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  keyPill.classList.add("hidden");
  videoEl.style.visibility = "visible";
}

function normalizePointerPosition(clientX, clientY) {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const clampedX = Math.min(vw, Math.max(0, clientX));
  const clampedY = Math.min(vh, Math.max(0, clientY));

  pointerState.inFrame = clientX >= 0 && clientX <= vw && clientY >= 0 && clientY <= vh;
  pointerState.xPct = clampedX / vw;
  pointerState.yPct = clampedY / vh;
  pointerState.x = pointerState.xPct * canvas.width;
  pointerState.y = pointerState.yPct * canvas.height;
}

function onMouseMove(e) {
  normalizePointerPosition(e.clientX, e.clientY);
  pushEvent({
    type: "mouse_move",
    x: pointerState.x,
    y: pointerState.y,
    xPct: pointerState.xPct,
    yPct: pointerState.yPct,
    inFrame: pointerState.inFrame,
  });
}

function onMouseDown(e) {
  normalizePointerPosition(e.clientX, e.clientY);
  if (e.button === 0 || e.button === 2) buttonDownSince[e.button] = recMs();

  pushEvent({
    type: "mouse_down",
    button: e.button,
    x: pointerState.x,
    y: pointerState.y,
    xPct: pointerState.xPct,
    yPct: pointerState.yPct,
    inFrame: pointerState.inFrame,
  });
}

function onMouseUp(e) {
  normalizePointerPosition(e.clientX, e.clientY);

  let holdMs = 0;
  if ((e.button === 0 || e.button === 2) && buttonDownSince[e.button] != null) {
    holdMs = recMs() - buttonDownSince[e.button];
    buttonDownSince[e.button] = null;
  }

  pushEvent({
    type: "mouse_up",
    button: e.button,
    holdMs,
    x: pointerState.x,
    y: pointerState.y,
    xPct: pointerState.xPct,
    yPct: pointerState.yPct,
    inFrame: pointerState.inFrame,
  });
}

function onKeyDown(e) {
  pushEvent({ type: "key_down", key: e.key, code: e.code });
}

function onKeyUp(e) {
  pushEvent({ type: "key_up", key: e.key, code: e.code });
}

function attachInteractionListeners() {
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mouseleave", onMouseLeave);
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

function removeInteractionListeners() {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mousedown", onMouseDown);
  window.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("mouseleave", onMouseLeave);
}

function onMouseLeave() {
  pushEvent({ type: "mouse_move", inFrame: false });
}

function refreshZoomList() {
  zoomList.innerHTML = "";
  project.zooms.forEach((z, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${z.startSec.toFixed(2)}s -> ${z.endSec.toFixed(2)}s | x${z.scale.toFixed(2)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "remove-btn";
    btn.onclick = () => {
      project.zooms.splice(idx, 1);
      refreshZoomList();
    };
    li.appendChild(btn);
    zoomList.appendChild(li);
  });
}

function refreshTextList() {
  textList.innerHTML = "";
  project.texts.forEach((t, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${t.startSec.toFixed(2)}s -> ${t.endSec.toFixed(2)}s | ${t.value}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "remove-btn";
    btn.onclick = () => {
      project.texts.splice(idx, 1);
      refreshTextList();
    };
    li.appendChild(btn);
    textList.appendChild(li);
  });
}

function addZoomFromForm() {
  const z = {
    startSec: Number(zoomStart.value),
    endSec: Number(zoomEnd.value),
    scale: Number(zoomScale.value),
    easeMs: Number(zoomEase.value),
  };

  if (!(z.endSec > z.startSec) || z.scale < 1) {
    setStatus("Invalid zoom settings.");
    return;
  }

  project.zooms.push(z);
  project.zooms.sort((a, b) => a.startSec - b.startSec);
  refreshZoomList();
}

function addTextFromForm() {
  const t = {
    startSec: Number(textStart.value),
    endSec: Number(textEnd.value),
    xPct: Number(textX.value),
    yPct: Number(textY.value),
    value: String(textValue.value || "").trim(),
  };

  if (!(t.endSec > t.startSec) || !t.value) {
    setStatus("Invalid text overlay settings.");
    return;
  }

  project.texts.push(t);
  project.texts.sort((a, b) => a.startSec - b.startSec);
  refreshTextList();
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function saveProjectJson() {
  const serializable = {
    durationSec: project.durationSec,
    recordedMimeType: project.recordedMimeType,
    captureBounds: project.captureBounds,
    events: project.events,
    zooms: project.zooms,
    texts: project.texts,
    cursorOffsetX: Number(project.cursorOffsetX || 0),
    cursorOffsetY: Number(project.cursorOffsetY || 0),
    cursorTextureDataUrl: project.cursorTextureDataUrl || "",
    cursorTextureName: project.cursorTextureName || "",
    cursorHotspotX: Number(project.cursorHotspotX || 0),
    cursorHotspotY: Number(project.cursorHotspotY || 0),
  };

  const blob = new Blob([JSON.stringify(serializable, null, 2)], { type: "application/json" });
  downloadBlob(blob, "guide-recorder-project.json");
}

async function applyLoadedProjectData(data) {
  project.events = Array.isArray(data.events) ? data.events : [];
  project.events.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
  project.zooms = Array.isArray(data.zooms) ? data.zooms : [];
  project.texts = Array.isArray(data.texts) ? data.texts : [];
  project.durationSec = Number(data.durationSec || 0);
  project.captureBounds = data.captureBounds && typeof data.captureBounds === "object"
    ? {
        x: Number(data.captureBounds.x || 0),
        y: Number(data.captureBounds.y || 0),
        width: Number(data.captureBounds.width || 0),
        height: Number(data.captureBounds.height || 0),
      }
    : null;
  project.cursorOffsetX = Number(data.cursorOffsetX || 0);
  project.cursorOffsetY = Number(data.cursorOffsetY || 0);
  project.cursorHotspotX = Number(data.cursorHotspotX || 0);
  project.cursorHotspotY = Number(data.cursorHotspotY || 0);
  project.cursorTextureName = String(data.cursorTextureName || "");
  cursorOffsetXInput.value = String(project.cursorOffsetX);
  cursorOffsetYInput.value = String(project.cursorOffsetY);
  syncCursorHotspotInputs();
  await loadCursorTextureFromDataUrl(String(data.cursorTextureDataUrl || ""), project.cursorTextureName);
  refreshZoomList();
  refreshTextList();
}

async function loadProjectJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  await applyLoadedProjectData(data);
  setStatus("Project JSON loaded. Attach a video to preview effects.");
}

async function tryDesktopAutoLoad() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("autoloaddesktop") !== "1") return;

  try {
    const jsonResp = await fetch("/__desktop/latest.json", { cache: "no-store" });
    if (!jsonResp.ok) {
      setStatus("Desktop autoload failed. Load video/json manually.");
      return;
    }

    const data = await jsonResp.json();

    await applyLoadedProjectData(data);

    if (importedVideoUrl && importedVideoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(importedVideoUrl);
    }
    importedVideoUrl = `/__desktop/latest.video?t=${Date.now()}`;
    videoEl.src = importedVideoUrl;
    videoEl.onloadedmetadata = () => {
      syncPreviewStageAspect();
      fitCanvasToVideo();
      startRenderLoop();
      refreshActionButtons();
    };
    saveProjectBtn.disabled = false;
    refreshActionButtons();
    setStatus("Desktop recording auto-loaded. Start editing.");
  } catch {
    setStatus("Desktop autoload failed. Load video/json manually.");
  }
}

async function startCapture() {
  try {
    setStatus("Selecting screen source...");
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        cursor: "never",
      },
      audio: true,
    });

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    chunks = [];
    project.events = [];
    buttonDownSince[0] = null;
    buttonDownSince[2] = null;
    project.recordedBlob = null;
    project.recordedMimeType = mimeType;
    recordStartMs = nowMs();

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 12000000 });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      project.recordedBlob = blob;
      project.durationSec = (nowMs() - recordStartMs) / 1000;

      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      recordingUrl = URL.createObjectURL(blob);
      videoEl.src = recordingUrl;
      videoEl.onloadedmetadata = () => {
        syncPreviewStageAspect();
        fitCanvasToVideo();
        startRenderLoop();
        refreshActionButtons();
      };

      saveProjectBtn.disabled = false;
      refreshActionButtons();
      setStatus(`Recorded ${project.durationSec.toFixed(2)}s. Add edits and preview.`);
    };

    mediaRecorder.start(100);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    saveProjectBtn.disabled = true;
    refreshActionButtons();

    attachInteractionListeners();
    setStatus("Recording... interact with your screen.");

    const [track] = mediaStream.getVideoTracks();
    track.onended = () => {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopCapture();
      }
    };
  } catch (err) {
    setStatus(`Capture failed: ${err.message || String(err)}`);
  }
}

function stopCapture() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  mediaRecorder.stop();
  removeInteractionListeners();

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startCapture);
stopBtn.addEventListener("click", stopCapture);

downloadBtn.addEventListener("click", () => {
  if (!project.recordedBlob) return;
  downloadBlob(project.recordedBlob, "guide-recorder-recording.webm");
});

saveProjectBtn.addEventListener("click", saveProjectJson);

loadProjectInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await loadProjectJson(file);
});

loadVideoInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (importedVideoUrl && importedVideoUrl.startsWith("blob:")) {
    URL.revokeObjectURL(importedVideoUrl);
  }
  importedVideoUrl = URL.createObjectURL(file);
  videoEl.src = importedVideoUrl;
  videoEl.onloadedmetadata = () => {
    syncPreviewStageAspect();
    fitCanvasToVideo();
    startRenderLoop();
    refreshActionButtons();
  };
  refreshActionButtons();
  setStatus(`Loaded video file: ${file.name}`);
});

addZoomBtn.addEventListener("click", addZoomFromForm);
addTextBtn.addEventListener("click", addTextFromForm);
exportFinalBtn.addEventListener("click", exportFinalVideo);
cursorOffsetXInput.addEventListener("input", () => {
  project.cursorOffsetX = Number(cursorOffsetXInput.value || 0);
});
cursorOffsetYInput.addEventListener("input", () => {
  project.cursorOffsetY = Number(cursorOffsetYInput.value || 0);
});
cursorHotspotXInput.addEventListener("input", () => {
  project.cursorHotspotX = Number(cursorHotspotXInput.value || 0);
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
});
cursorHotspotYInput.addEventListener("input", () => {
  project.cursorHotspotY = Number(cursorHotspotYInput.value || 0);
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
});
cursorTextureInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await loadCursorTextureFromDataUrl(dataUrl, file.name);
    setStatus(`Loaded cursor texture: ${file.name}`);
  } catch (err) {
    setStatus(`Failed to load cursor texture: ${err.message || String(err)}`);
  } finally {
    cursorTextureInput.value = "";
  }
});
cursorTextureClearBtn.addEventListener("click", async () => {
  await loadCursorTextureFromDataUrl("");
  setStatus("Cleared cursor texture.");
});
cursorPreviewCanvas.addEventListener("click", (e) => {
  if (!cursorTextureImage || !cursorPreviewMap) return;
  const bounds = cursorPreviewCanvas.getBoundingClientRect();
  const x = e.clientX - bounds.left;
  const y = e.clientY - bounds.top;
  const localX = x - cursorPreviewMap.dx;
  const localY = y - cursorPreviewMap.dy;
  if (localX < 0 || localY < 0 || localX > cursorPreviewMap.drawW || localY > cursorPreviewMap.drawH) return;

  project.cursorHotspotX = Math.round((localX / cursorPreviewMap.drawW) * cursorTextureImage.width);
  project.cursorHotspotY = Math.round((localY / cursorPreviewMap.drawH) * cursorTextureImage.height);
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
});

videoEl.addEventListener("play", startRenderLoop);
videoEl.addEventListener("pause", () => {
  stopRenderLoop();
  clearOverlay();
  syncPlaybackUi();
});
videoEl.addEventListener("seeked", renderOverlay);
videoEl.addEventListener("timeupdate", syncPlaybackUi);
videoEl.addEventListener("loadedmetadata", () => {
  syncPreviewStageAspect();
  fitCanvasToVideo();
  syncPlaybackUi();
});
videoEl.addEventListener("ended", syncPlaybackUi);
window.addEventListener("resize", fitCanvasToVideo);

playPauseBtn.addEventListener("click", async () => {
  if (!videoEl.src) return;
  if (videoEl.paused) {
    try {
      await videoEl.play();
    } catch {
      // ignore autoplay restrictions
    }
  } else {
    videoEl.pause();
  }
  syncPlaybackUi();
});

seekBar.addEventListener("input", () => {
  if (!videoEl.src) return;
  const dur = Number(videoEl.duration || 0);
  if (!dur) return;
  isSeeking = true;
  const p = Number(seekBar.value) / 1000;
  videoEl.currentTime = dur * p;
  syncPlaybackUi();
});

seekBar.addEventListener("change", () => {
  isSeeking = false;
  syncPlaybackUi();
});

setStatus("Idle. Start Capture to begin.");
refreshActionButtons();
syncPlaybackUi();
renderCursorPreviewCanvas();
loadCursorPrefsFromLocalStorage().finally(() => {
  tryDesktopAutoLoad();
});





