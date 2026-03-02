const exportFinalBtn = document.getElementById("exportFinalBtn");
const saveProjectBtn = document.getElementById("saveProjectBtn");
const loadProjectInput = document.getElementById("loadProjectInput");
const loadVideoInput = document.getElementById("loadVideoInput");
const statusEl = document.getElementById("status");
const playPauseBtn = document.getElementById("playPauseBtn");
const seekBar = document.getElementById("seekBar");
const timeLabel = document.getElementById("timeLabel");
const timelineSurface = document.getElementById("timelineSurface");
const timelinePlayhead = document.getElementById("timelinePlayhead");
const zoomTrack = document.getElementById("zoomTrack");
const textTrack = document.getElementById("textTrack");
const zoomAddBtn = document.getElementById("zoomAddBtn");
const textAddBtn = document.getElementById("textAddBtn");
const zoomGhost = document.getElementById("zoomGhost");
const textGhost = document.getElementById("textGhost");
const effectEditor = document.getElementById("effectEditor");
const effectEditorTitle = document.getElementById("effectEditorTitle");
const effectEditorFields = document.getElementById("effectEditorFields");
const effectEditorCloseBtn = document.getElementById("effectEditorCloseBtn");
const effectEditorDeleteBtn = document.getElementById("effectEditorDeleteBtn");
const cursorSettingsBtn = document.getElementById("cursorSettingsBtn");
const cursorPopover = document.getElementById("cursorPopover");
const cursorPopoverCloseBtn = document.getElementById("cursorPopoverCloseBtn");

const videoEl = document.getElementById("previewVideo");
const canvas = document.getElementById("overlayCanvas");
const ctx = canvas.getContext("2d");
const previewWrapEl = document.querySelector(".preview-wrap");
const previewViewportEl = document.getElementById("previewViewport");
const previewStageEl = document.getElementById("previewStage");
const previewControlsEl = document.querySelector(".preview-controls");
const effectsTimelineEl = document.getElementById("effectsTimeline");
const keyPill = document.getElementById("liveKeyPill");

const cursorOffsetXInput = document.getElementById("cursorOffsetX");
const cursorOffsetYInput = document.getElementById("cursorOffsetY");
const cursorTextureInput = document.getElementById("cursorTextureInput");
const cursorTextureClearBtn = document.getElementById("cursorTextureClearBtn");
const cursorHotspotXInput = document.getElementById("cursorHotspotX");
const cursorHotspotYInput = document.getElementById("cursorHotspotY");
const cursorPreviewCanvas = document.getElementById("cursorPreviewCanvas");
const cursorPreviewCtx = cursorPreviewCanvas.getContext("2d");
const TIMELINE_LABEL_COL_PX = 64;

let importedVideoUrl = "";
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
let uiPrimedForPlayback = false;
const MIN_EFFECT_DURATION_SEC = 0.2;
const EFFECT_RESIZE_EDGE_PX = 12;

const timelineHoverSec = {
  zoom: 0,
  text: 0,
};

let editingEffect = null;
let resizingEffect = null;
let effectEditorAnchorPoint = null;
let suppressNextSegmentClick = false;

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

function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg;
}

function refreshActionButtons() {
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

function snapNearZero(sec) {
  const v = Number(sec || 0);
  if (!Number.isFinite(v)) return 0;
  return v < 0.03 ? 0 : v;
}

function uiCurrentSec(rawSec) {
  const sec = snapNearZero(rawSec);
  if (!uiPrimedForPlayback && sec < 0.25) return 0;
  return sec;
}

function syncPlaybackUi() {
  const dur = effectiveDurationSec();
  const curNow = uiCurrentSec(videoEl.currentTime);
  const cur = dur > 0 ? Math.min(curNow, dur) : curNow;

  if (!isSeeking) {
    if (dur > 0) seekBar.value = String(Math.round((cur / dur) * 1000));
    else seekBar.value = "0";
  }
  timeLabel.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
  playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
  updateTimelinePlayhead(cur, dur);
}

function effectiveDurationSecFor(sourceDuration) {
  const videoDuration = Number(sourceDuration || 0);
  const projectDuration = Number(project.durationSec || 0);
  if (videoDuration > 0 && projectDuration > 0) return Math.min(videoDuration, projectDuration);
  return Math.max(videoDuration, projectDuration, 0);
}

function effectiveDurationSec() {
  return effectiveDurationSecFor(videoEl.duration);
}

function clampPlaybackToEffectiveDuration() {
  const maxSec = effectiveDurationSec();
  if (!videoEl.src || maxSec <= 0) return;
  if (Number(videoEl.currentTime || 0) <= maxSec) return;
  videoEl.currentTime = maxSec;
  videoEl.pause();
}

function formatSec(ms) {
  return (ms / 1000).toFixed(2);
}

function timelineDurationSec() {
  const mediaDur = effectiveDurationSec();
  let overlayDur = 0;
  for (const z of project.zooms) {
    overlayDur = Math.max(overlayDur, Number(z.endSec || 0));
  }
  for (const t of project.texts) {
    overlayDur = Math.max(overlayDur, Number(t.endSec || 0));
  }
  return Math.max(mediaDur, overlayDur, 0.1);
}

function createTimelineSegment(kind, startSec, endSec, label, durSec) {
  const start = Math.max(0, Number(startSec || 0));
  const end = Math.max(start, Number(endSec || 0));
  if (end <= start) return null;

  const el = document.createElement("span");
  el.className = `timeline-segment ${kind}`;
  el.textContent = label;
  el.style.left = `${(start / durSec) * 100}%`;
  el.style.width = `${Math.max(0.6, ((end - start) / durSec) * 100)}%`;
  el.title = `${label} (${start.toFixed(2)}s - ${end.toFixed(2)}s)`;
  return el;
}

function sortEffects() {
  project.zooms.sort((a, b) => Number(a.startSec || 0) - Number(b.startSec || 0));
  project.texts.sort((a, b) => Number(a.startSec || 0) - Number(b.startSec || 0));
}

function effectsFor(kind) {
  return kind === "zoom" ? project.zooms : project.texts;
}

function hideEffectEditor() {
  editingEffect = null;
  effectEditorAnchorPoint = null;
  effectEditor.classList.add("hidden");
  effectEditorFields.innerHTML = "";
  renderEffectsTimeline();
}

function positionEffectEditor(anchorEl = null, anchorPoint = null) {
  if (!effectEditor || effectEditor.classList.contains("hidden")) return;
  const host = document.getElementById("effectsTimeline");
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  const editorRect = effectEditor.getBoundingClientRect();

  let centerX = hostRect.left + hostRect.width / 2;
  let topY = hostRect.top + 6;
  if (anchorPoint && Number.isFinite(anchorPoint.clientX) && Number.isFinite(anchorPoint.clientY)) {
    centerX = anchorPoint.clientX;
    topY = anchorPoint.clientY - editorRect.height - 8;
  } else if (anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    centerX = a.left + a.width / 2;
    topY = a.top - editorRect.height - 10;
  }

  const minLeft = hostRect.left + 6;
  const maxLeft = hostRect.right - editorRect.width - 6;
  const leftPx = Math.max(minLeft, Math.min(maxLeft, centerX - editorRect.width / 2));
  const topPx = Math.min(hostRect.bottom - editorRect.height - 6, topY);
  effectEditor.style.left = `${Math.round(leftPx - hostRect.left)}px`;
  effectEditor.style.top = `${Math.round(topPx - hostRect.top)}px`;
}

function toggleCursorPopover(show) {
  if (!cursorPopover) return;
  if (show) cursorPopover.classList.remove("hidden");
  else cursorPopover.classList.add("hidden");
}

function clampEffectBounds(effect) {
  const start = Math.max(0, Number(effect.startSec || 0));
  const end = Math.max(start + MIN_EFFECT_DURATION_SEC, Number(effect.endSec || 0));
  effect.startSec = start;
  effect.endSec = end;
}

function resizeSideFromPoint(segEl, clientX) {
  if (!segEl) return null;
  const rect = segEl.getBoundingClientRect();
  const localX = clientX - rect.left;
  const edgePx = Math.min(EFFECT_RESIZE_EDGE_PX, Math.max(8, rect.width * 0.25));
  if (localX <= edgePx) return "left";
  if (localX >= rect.width - edgePx) return "right";
  return null;
}

function openEffectEditor(kind, index, anchorEl = null, anchorPoint = null) {
  const list = effectsFor(kind);
  const effect = list[index];
  if (!effect) return;
  effectEditorAnchorPoint = anchorPoint && Number.isFinite(anchorPoint.clientX) && Number.isFinite(anchorPoint.clientY)
    ? { clientX: anchorPoint.clientX, clientY: anchorPoint.clientY }
    : null;
  editingEffect = { kind, index, effect };
  renderEffectsTimeline();
  effectEditor.classList.remove("hidden");
  effectEditorTitle.textContent = kind === "zoom" ? "Edit Zoom Segment" : "Edit Text Segment";

  if (kind === "zoom") {
    effectEditorFields.innerHTML = `
      <div class="grid2">
        <label>Start (s)<input data-key="startSec" type="number" min="0" step="0.1" value="${Number(effect.startSec || 0).toFixed(2)}" /></label>
        <label>End (s)<input data-key="endSec" type="number" min="0" step="0.1" value="${Number(effect.endSec || 0).toFixed(2)}" /></label>
        <label>Scale<input data-key="scale" type="number" min="1" step="0.1" value="${Number(effect.scale || 1.8).toFixed(2)}" /></label>
        <label>Smooth (ms)<input data-key="easeMs" type="number" min="0" step="10" value="${Math.round(Number(effect.easeMs || 180))}" /></label>
      </div>
    `;
  } else {
    effectEditorFields.innerHTML = `
      <div class="grid2">
        <label>Start (s)<input data-key="startSec" type="number" min="0" step="0.1" value="${Number(effect.startSec || 0).toFixed(2)}" /></label>
        <label>End (s)<input data-key="endSec" type="number" min="0" step="0.1" value="${Number(effect.endSec || 0).toFixed(2)}" /></label>
        <label>X (%)<input data-key="xPct" type="number" min="0" max="100" step="1" value="${Math.round(Number(effect.xPct || 0))}" /></label>
        <label>Y (%)<input data-key="yPct" type="number" min="0" max="100" step="1" value="${Math.round(Number(effect.yPct || 0))}" /></label>
      </div>
      <label>Text<input data-key="value" type="text" value="${String(effect.value || "").replace(/"/g, "&quot;")}" /></label>
    `;
  }

  for (const input of effectEditorFields.querySelectorAll("input")) {
    input.addEventListener("input", () => {
      const active = editingEffect?.effect;
      if (!active) return;
      const key = input.dataset.key;
      if (!key) return;
      if (key === "value") {
        active.value = String(input.value || "");
      } else {
        active[key] = Number(input.value || 0);
      }
      if (kind === "zoom") {
        active.scale = Math.max(1, Number(active.scale || 1));
        active.easeMs = Math.max(0, Number(active.easeMs || 0));
      } else {
        active.xPct = Math.max(0, Math.min(100, Number(active.xPct || 0)));
        active.yPct = Math.max(0, Math.min(100, Number(active.yPct || 0)));
      }
      clampEffectBounds(active);
      sortEffects();
      editingEffect.index = effectsFor(kind).indexOf(active);
      renderEffectsTimeline();
      syncPlaybackUi();
    });
  }

  requestAnimationFrame(() => {
    const freshAnchor = anchorEl && anchorEl.isConnected
      ? anchorEl
      : timelineSurface.querySelector(`.timeline-segment[data-kind="${kind}"][data-index="${editingEffect.index}"]`);
    positionEffectEditor(freshAnchor || null, effectEditorAnchorPoint);
  });
}

function deleteEffect(kind, index) {
  const list = effectsFor(kind);
  if (!list || index < 0 || index >= list.length) return false;
  const effect = list[index];
  list.splice(index, 1);
  if (editingEffect && editingEffect.kind === kind && editingEffect.effect === effect) {
    hideEffectEditor();
  } else {
    renderEffectsTimeline();
  }
  syncPlaybackUi();
  return true;
}

function deleteSelectedEffect() {
  if (!editingEffect) return false;
  const list = effectsFor(editingEffect.kind);
  const idx = list.indexOf(editingEffect.effect);
  if (idx < 0) return false;
  return deleteEffect(editingEffect.kind, idx);
}

function buildTrackSegments(kind, trackEl, durSec) {
  const list = effectsFor(kind);
  list.forEach((item, index) => {
    const label = kind === "zoom"
      ? `x${Number(item.scale || 1).toFixed(1)}`
      : (String(item.value || "Text").trim() || "Text");
    const seg = createTimelineSegment(kind, item.startSec, item.endSec, label, durSec);
    if (!seg) return;
    seg.dataset.kind = kind;
    seg.dataset.index = String(index);
    if (editingEffect && editingEffect.kind === kind && editingEffect.effect === item) {
      seg.classList.add("selected");
    }
    seg.innerHTML = `<span class="timeline-segment-label">${label}</span>
      <button class="timeline-remove-btn" type="button" aria-label="Remove effect" title="Remove effect">x</button>
      <span class="timeline-handle left" data-side="left"></span>
      <span class="timeline-handle right" data-side="right"></span>`;
    trackEl.appendChild(seg);
  });
}

function renderEffectsTimeline() {
  if (!zoomTrack || !textTrack) return;
  if (zoomAddBtn && zoomAddBtn.parentElement !== zoomTrack) zoomTrack.appendChild(zoomAddBtn);
  if (textAddBtn && textAddBtn.parentElement !== textTrack) textTrack.appendChild(textAddBtn);
  for (const el of zoomTrack.querySelectorAll(".timeline-segment")) el.remove();
  for (const el of textTrack.querySelectorAll(".timeline-segment")) el.remove();
  const durSec = timelineDurationSec();

  buildTrackSegments("zoom", zoomTrack, durSec);
  buildTrackSegments("text", textTrack, durSec);

  const cur = Number(videoEl.currentTime || 0);
  const mediaDur = effectiveDurationSec();
  const activeDur = mediaDur > 0 ? mediaDur : durSec;
  updateTimelinePlayhead(cur, activeDur);
  const p = Math.max(0, Math.min(1, cur / Math.max(0.001, activeDur)));
  if (zoomAddBtn && !zoomAddBtn.style.left) zoomAddBtn.style.left = `${p * 100}%`;
  if (textAddBtn && !textAddBtn.style.left) textAddBtn.style.left = `${p * 100}%`;
  timelineHoverSec.zoom = p * activeDur;
  timelineHoverSec.text = p * activeDur;
}

function updateTimelinePlayhead(curSec, durSec) {
  if (!timelinePlayhead) return;
  const dur = Math.max(0.001, Number(durSec || 0.001));
  const p = Math.max(0, Math.min(1, Number(curSec || 0) / dur));
  const fullW = Math.max(1, timelineSurface.getBoundingClientRect().width);
  const trackW = Math.max(1, fullW - TIMELINE_LABEL_COL_PX);
  const x = TIMELINE_LABEL_COL_PX + p * trackW;
  timelinePlayhead.style.left = `${x}px`;
}

function fitCanvasToVideo() {
  const rect = videoEl.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
}

function syncPreviewStageAspect() {
  const vw = Number(videoEl.videoWidth || 0);
  const vh = Number(videoEl.videoHeight || 0);
  if (!previewStageEl || !previewViewportEl || vw <= 0 || vh <= 0) return;

  // Fit stage strictly inside viewport rect (contain; never clip, never overlap controls).
  const viewportW = Math.max(1, Number(previewViewportEl.clientWidth || 1));
  const viewportH = Math.max(1, Number(previewViewportEl.clientHeight || 1));
  const scale = Math.min(viewportW / vw, viewportH / vh);
  const targetW = Math.max(1, Math.floor(vw * scale));
  const targetH = Math.max(1, Math.floor(vh * scale));

  previewStageEl.style.aspectRatio = `${vw} / ${vh}`;
  previewStageEl.style.width = `${targetW}px`;
  previewStageEl.style.height = `${targetH}px`;
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
      cursorOffsetX: Number(project.cursorOffsetX || 0),
      cursorOffsetY: Number(project.cursorOffsetY || 0),
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
    project.cursorOffsetX = Number(data.cursorOffsetX || 0);
    project.cursorOffsetY = Number(data.cursorOffsetY || 0);
    project.cursorHotspotX = Number(data.cursorHotspotX || 0);
    project.cursorHotspotY = Number(data.cursorHotspotY || 0);
    project.cursorTextureName = String(data.cursorTextureName || "");
    cursorOffsetXInput.value = String(project.cursorOffsetX);
    cursorOffsetYInput.value = String(project.cursorOffsetY);
    syncCursorHotspotInputs();
    await loadCursorTextureFromDataUrl(
      String(data.cursorTextureDataUrl || ""),
      project.cursorTextureName
    );
  } catch {
    // Ignore malformed stored data.
  }
}

async function loadCursorTextureFromDataUrl(dataUrl, name = "", shouldPersist = true) {
  if (!dataUrl) {
    cursorTextureImage = null;
    project.cursorTextureDataUrl = "";
    project.cursorTextureName = "";
    project.cursorHotspotX = 0;
    project.cursorHotspotY = 0;
    syncCursorHotspotInputs();
    renderCursorPreviewCanvas();
    if (shouldPersist) persistCursorPrefsToLocalStorage();
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
  if (shouldPersist) persistCursorPrefsToLocalStorage();
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
    if (evt.inFrame === false) continue;
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
  let inFrame = false;
  for (const evt of project.events) {
    if (evt.t > currentMs) break;
    if (evt.type !== "mouse_move" && evt.type !== "mouse_down" && evt.type !== "mouse_up") continue;
    if (evt.inFrame === false) {
      inFrame = false;
      continue;
    }
    const pos = eventToCanvasPosition(evt);
    if (!pos) continue;
    latest = pos;
    inFrame = true;
  }

  if (!latest || !inFrame) {
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
  let inFrame = false;
  for (const evt of project.events) {
    if (evt.t > currentMs) break;
    if (evt.type !== "mouse_move" && evt.type !== "mouse_down" && evt.type !== "mouse_up") continue;
    if (evt.inFrame === false) {
      inFrame = false;
      continue;
    }
    const pos = exportEventToPosition(evt, width, height);
    if (!pos) continue;
    latest = pos;
    inFrame = true;
  }

  if (!latest || !inFrame) return { inFrame: false, x: width / 2, y: height / 2 };
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
    if (evt.inFrame === false) continue;
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
    const targetDurationSec = effectiveDurationSecFor(exportVideo.duration);
    const targetDurationMs = targetDurationSec > 0 ? targetDurationSec * 1000 : 0;

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
      const clampedMs = targetDurationMs > 0 ? Math.min(currentMs, targetDurationMs) : currentMs;
      renderExportFrame(exportCtx, exportVideo, clampedMs, width, height);

      if ((targetDurationMs > 0 && clampedMs >= targetDurationMs) || exportVideo.ended) {
        done = true;
        try {
          exportVideo.pause();
          if (targetDurationSec > 0) exportVideo.currentTime = targetDurationSec;
        } catch {
          // ignore
        }
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
  const rawSec = snapNearZero(videoEl.currentTime);
  const currentMs = Math.max(0, rawSec * 1000);
  const uiSec = uiCurrentSec(rawSec);
  const curSec = currentMs / 1000;
  const dur = effectiveDurationSec();
  updateTimelinePlayhead(uiSec, dur);
  if (!isSeeking) {
    if (dur > 0) seekBar.value = String(Math.round((uiSec / dur) * 1000));
    else seekBar.value = "0";
  }
  timeLabel.textContent = `${formatClock(uiSec)} / ${formatClock(dur)}`;
  playPauseBtn.textContent = "Pause";
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
  await loadCursorTextureFromDataUrl(
    String(data.cursorTextureDataUrl || ""),
    project.cursorTextureName,
    false
  );
  sortEffects();
  renderEffectsTimeline();
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
      renderEffectsTimeline();
    };
    saveProjectBtn.disabled = false;
    refreshActionButtons();
    setStatus("Desktop recording auto-loaded. Start editing.");
  } catch {
    setStatus("Desktop autoload failed. Load video/json manually.");
  }
}

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
    renderEffectsTimeline();
  };
  refreshActionButtons();
  setStatus(`Loaded video file: ${file.name}`);
});

exportFinalBtn.addEventListener("click", exportFinalVideo);
cursorOffsetXInput.addEventListener("input", () => {
  project.cursorOffsetX = Number(cursorOffsetXInput.value || 0);
  persistCursorPrefsToLocalStorage();
});
cursorOffsetYInput.addEventListener("input", () => {
  project.cursorOffsetY = Number(cursorOffsetYInput.value || 0);
  persistCursorPrefsToLocalStorage();
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
videoEl.addEventListener("play", () => {
  uiPrimedForPlayback = true;
});
videoEl.addEventListener("pause", () => {
  stopRenderLoop();
  clearOverlay();
  syncPlaybackUi();
});
videoEl.addEventListener("seeked", renderOverlay);
videoEl.addEventListener("timeupdate", () => {
  clampPlaybackToEffectiveDuration();
  syncPlaybackUi();
});
videoEl.addEventListener("loadedmetadata", () => {
  uiPrimedForPlayback = false;
  syncPreviewStageAspect();
  fitCanvasToVideo();
  syncPlaybackUi();
  renderEffectsTimeline();
});
videoEl.addEventListener("ended", syncPlaybackUi);
window.addEventListener("resize", fitCanvasToVideo);
window.addEventListener("resize", renderEffectsTimeline);
window.addEventListener("resize", syncPreviewStageAspect);
window.addEventListener("resize", () => requestAnimationFrame(syncPreviewStageAspect));

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
  uiPrimedForPlayback = true;
  const dur = effectiveDurationSec();
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

function timeFromTrackPointer(trackEl, clientX) {
  const rect = trackEl.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return p * timelineDurationSec();
}

function setLaneAddButtonPosition(kind, clientX) {
  const trackEl = kind === "zoom" ? zoomTrack : textTrack;
  const addBtn = kind === "zoom" ? zoomAddBtn : textAddBtn;
  const ghostEl = kind === "zoom" ? zoomGhost : textGhost;
  if (!trackEl || !addBtn || !ghostEl) return;
  const rect = trackEl.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const totalDur = timelineDurationSec();
  const defaultDur = 2;
  let startSec = p * totalDur;
  let endSec = Math.min(totalDur, startSec + defaultDur);
  if (endSec - startSec < defaultDur) {
    startSec = Math.max(0, endSec - defaultDur);
  }
  timelineHoverSec[kind] = startSec;
  const leftPct = (startSec / totalDur) * 100;
  const widthPct = Math.max(0.6, ((endSec - startSec) / totalDur) * 100);
  ghostEl.style.left = `${leftPct}%`;
  ghostEl.style.width = `${widthPct}%`;
  ghostEl.classList.remove("hidden");
  addBtn.style.left = `${leftPct}%`;
}

function setLaneAddBlocked(kind, blocked) {
  const addBtn = kind === "zoom" ? zoomAddBtn : textAddBtn;
  const ghostEl = kind === "zoom" ? zoomGhost : textGhost;
  if (!addBtn || !ghostEl) return;
  addBtn.classList.toggle("blocked", Boolean(blocked));
  if (blocked) ghostEl.classList.add("hidden");
}

function onLanePointerMove(kind, e) {
  const overSegment = Boolean(e.target?.closest(".timeline-segment"));
  setLaneAddBlocked(kind, overSegment);
  if (overSegment) return;
  setLaneAddButtonPosition(kind, e.clientX);
}

function addEffectAt(kind, atSec) {
  const startSec = Math.max(0, Number(atSec || 0));
  if (kind === "zoom") {
    const z = {
      startSec,
      endSec: startSec + 2,
      scale: 1.8,
      easeMs: 180,
    };
    project.zooms.push(z);
    sortEffects();
    renderEffectsTimeline();
    return;
  }
  const t = {
    startSec,
    endSec: startSec + 2,
    xPct: 12,
    yPct: 12,
    value: "Text",
  };
  project.texts.push(t);
  sortEffects();
  renderEffectsTimeline();
}

zoomTrack.addEventListener("pointermove", (e) => onLanePointerMove("zoom", e));
textTrack.addEventListener("pointermove", (e) => onLanePointerMove("text", e));
zoomTrack.addEventListener("pointerenter", (e) => onLanePointerMove("zoom", e));
textTrack.addEventListener("pointerenter", (e) => onLanePointerMove("text", e));
zoomTrack.addEventListener("pointerleave", () => {
  if (zoomGhost) zoomGhost.classList.add("hidden");
});
textTrack.addEventListener("pointerleave", () => {
  if (textGhost) textGhost.classList.add("hidden");
});

zoomAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  addEffectAt("zoom", timelineHoverSec.zoom || Number(videoEl.currentTime || 0));
});
textAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  addEffectAt("text", timelineHoverSec.text || Number(videoEl.currentTime || 0));
});

timelineSurface.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".timeline-remove-btn");
  if (removeBtn) {
    e.preventDefault();
    e.stopPropagation();
    const segEl = removeBtn.closest(".timeline-segment");
    if (!segEl) return;
    const kind = segEl.dataset.kind;
    const index = Number(segEl.dataset.index || -1);
    if ((kind === "zoom" || kind === "text") && index >= 0) {
      deleteEffect(kind, index);
    }
    return;
  }
  const handleEl = e.target.closest(".timeline-handle");
  if (handleEl) return;
  const segEl = e.target.closest(".timeline-segment");
  if (segEl) {
    if (suppressNextSegmentClick) {
      suppressNextSegmentClick = false;
      return;
    }
    const kind = segEl.dataset.kind;
    const index = Number(segEl.dataset.index || -1);
    if ((kind === "zoom" || kind === "text") && index >= 0) {
      openEffectEditor(kind, index, segEl, { clientX: e.clientX, clientY: e.clientY });
    }
    return;
  }
  if (!videoEl.src) return;
  uiPrimedForPlayback = true;
  const dur = effectiveDurationSec();
  if (!(dur > 0)) return;
  const rect = timelineSurface.getBoundingClientRect();
  const localX = e.clientX - rect.left;
  const trackX = Math.max(0, Math.min(Math.max(1, rect.width - TIMELINE_LABEL_COL_PX), localX - TIMELINE_LABEL_COL_PX));
  const p = trackX / Math.max(1, rect.width - TIMELINE_LABEL_COL_PX);
  videoEl.currentTime = dur * p;
  syncPlaybackUi();
  if (videoEl.paused) renderOverlay();
});

timelineSurface.addEventListener("pointerdown", (e) => {
  const segEl = e.target.closest(".timeline-segment");
  if (!segEl) return;
  const handleEl = e.target.closest(".timeline-handle");
  e.preventDefault();
  e.stopPropagation();
  const kind = segEl.dataset.kind;
  const index = Number(segEl.dataset.index || -1);
  const side = (handleEl && (handleEl.dataset.side === "left" || handleEl.dataset.side === "right"))
    ? handleEl.dataset.side
    : resizeSideFromPoint(segEl, e.clientX);
  const list = effectsFor(kind);
  const effect = list[index];
  const trackEl = kind === "zoom" ? zoomTrack : textTrack;
  if (!effect || !trackEl || (side !== "left" && side !== "right")) return;
  suppressNextSegmentClick = true;
  resizingEffect = {
    kind,
    effect,
    side,
    trackEl,
    startClientX: e.clientX,
    origStart: Number(effect.startSec || 0),
    origEnd: Number(effect.endSec || 0),
    durSec: timelineDurationSec(),
  };
});

window.addEventListener("pointermove", (e) => {
  if (!resizingEffect) return;
  const { kind, effect, side, trackEl, startClientX, origStart, origEnd, durSec } = resizingEffect;
  if (!effect) return;
  const dx = e.clientX - startClientX;
  const deltaSec = (dx / Math.max(1, trackEl.getBoundingClientRect().width)) * durSec;
  if (side === "left") {
    effect.startSec = Math.max(0, Math.min(origEnd - MIN_EFFECT_DURATION_SEC, origStart + deltaSec));
  } else {
    effect.endSec = Math.max(origStart + MIN_EFFECT_DURATION_SEC, origEnd + deltaSec);
  }
  clampEffectBounds(effect);
  sortEffects();
  renderEffectsTimeline();
  syncPlaybackUi();
  document.body.style.cursor = "ew-resize";
});

window.addEventListener("pointerup", () => {
  if (resizingEffect) {
    suppressNextSegmentClick = true;
  }
  resizingEffect = null;
  document.body.style.cursor = "";
});

timelineSurface.addEventListener("pointermove", (e) => {
  if (resizingEffect) {
    timelineSurface.style.cursor = "ew-resize";
    return;
  }
  const segEl = e.target.closest(".timeline-segment");
  if (!segEl) {
    timelineSurface.style.cursor = "pointer";
    return;
  }
  const side = resizeSideFromPoint(segEl, e.clientX);
  timelineSurface.style.cursor = side ? "ew-resize" : "pointer";
});

timelineSurface.addEventListener("pointerleave", () => {
  if (!resizingEffect) timelineSurface.style.cursor = "pointer";
});

effectEditorCloseBtn.addEventListener("click", () => {
  hideEffectEditor();
});

effectEditorDeleteBtn.addEventListener("click", () => {
  deleteSelectedEffect();
});

if (cursorSettingsBtn) {
  cursorSettingsBtn.addEventListener("click", () => {
    const shouldShow = cursorPopover?.classList.contains("hidden");
    toggleCursorPopover(Boolean(shouldShow));
  });
}
if (cursorPopoverCloseBtn) {
  cursorPopoverCloseBtn.addEventListener("click", () => {
    toggleCursorPopover(false);
  });
}

window.addEventListener("pointerdown", (e) => {
  const target = e.target;
  if (!target) return;
  if (cursorPopover && !cursorPopover.classList.contains("hidden")) {
    if (!cursorPopover.contains(target) && !cursorSettingsBtn?.contains(target)) {
      toggleCursorPopover(false);
    }
  }
  if (effectEditor && !effectEditor.classList.contains("hidden")) {
    const clickedSeg = target.closest?.(".timeline-segment");
    const clickedHandle = target.closest?.(".timeline-handle");
    if (!effectEditor.contains(target) && !clickedSeg && !clickedHandle) {
      hideEffectEditor();
    }
  }
});

window.addEventListener("resize", () => {
  positionEffectEditor(null, effectEditorAnchorPoint);
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Delete") return;
  const target = e.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  if (deleteSelectedEffect()) {
    e.preventDefault();
  }
});

setStatus("Idle. Load recording JSON/video to begin editing.");
refreshActionButtons();
syncPlaybackUi();
renderCursorPreviewCanvas();
renderEffectsTimeline();
requestAnimationFrame(syncPreviewStageAspect);

(async () => {
  await tryDesktopAutoLoad();
  await loadCursorPrefsFromLocalStorage();
})();





