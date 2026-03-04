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
const trimTrack = document.getElementById("trimTrack");
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
const effectEditorDuplicateBtn = document.getElementById("effectEditorDuplicateBtn");
const cursorSettingsBtn = document.getElementById("cursorSettingsBtn");
const cursorPopover = document.getElementById("cursorPopover");
const cursorPopoverCloseBtn = document.getElementById("cursorPopoverCloseBtn");
const renderSettingsBtn = document.getElementById("renderSettingsBtn");
const renderSettingsPopover = document.getElementById("renderSettingsPopover");
const renderSettingsCloseBtn = document.getElementById("renderSettingsCloseBtn");
const aspectPresetSelect = document.getElementById("aspectPresetSelect");

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
const cursorMotionModeSelect = document.getElementById("cursorMotionMode");
const cursorSplineGuideHzInput = document.getElementById("cursorSplineGuideHz");
const cursorPreviewCanvas = document.getElementById("cursorPreviewCanvas");
const cursorPreviewCtx = cursorPreviewCanvas.getContext("2d");
const renderTransportSelect = document.getElementById("renderTransportSelect");
const renderFpsModeSelect = document.getElementById("renderFpsModeSelect");
const renderFpsValueInput = document.getElementById("renderFpsValueInput");
const TIMELINE_LABEL_COL_PX = 64;

let importedVideoUrl = "";
let rafId = 0;
let isSeeking = false;
let previewFrameCanvas = null;
let previewFrameCtx = null;
let composeCanvas = null;
let composeCtx = null;
let gpuZoomRenderer = null;
let gpuZoomDisabled = false;
const PREVIEW_EXPORT_VIDEO_BITRATE = 32000000;
const CURSOR_PREFS_STORAGE_KEY = "guide-recorder.cursor-prefs.v1";
const EDITOR_DRAFT_DB_NAME = "guide-recorder-editor";
const EDITOR_DRAFT_STORE = "drafts";
const EDITOR_DRAFT_PROJECT_KEY = "project";
const EDITOR_DRAFT_VIDEO_KEY = "video";
const EFFECT_CLIPBOARD_STORAGE_KEY = "guide-recorder.effect-clipboard.v1";
const DETERMINISTIC_EXPORT_MAX_FRAMES = 12000;
const GPU_ZOOM_COMPOSITE_ENABLED = true;
let cursorTextureImage = null;
let cursorPreviewMap = null;
let uiPrimedForPlayback = false;
const MIN_EFFECT_DURATION_SEC = 0.2;
const MIN_TRIM_DURATION_SEC = 0.05;
const EFFECT_RESIZE_EDGE_PX = 20;
const CAMERA_DEADZONE_RATIO = 0.22;
const ASPECT_PRESET_VALUES = {
  "16:9": 16 / 9,
  "1:1": 1,
  "9:16": 9 / 16,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "21:9": 21 / 9,
};
const TEXT_FONT_OPTIONS = [
  { label: "Segoe UI", value: "Segoe UI" },
  { label: "Bricolage Grotesque", value: "Bricolage Grotesque" },
  { label: "IBM Plex Mono", value: "IBM Plex Mono" },
  { label: "Patrick Hand", value: "Patrick Hand" },
  { label: "Arial", value: "Arial" },
  { label: "Verdana", value: "Verdana" },
  { label: "Trebuchet MS", value: "Trebuchet MS" },
  { label: "Georgia", value: "Georgia" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Courier New", value: "Courier New" },
];
const TEXT_TRANSITION_OPTIONS = [
  { label: "None", value: "none" },
  { label: "Grow", value: "grow" },
  { label: "Fade", value: "fade" },
];
const DEBUG_TEXT_FONT = false;
const textFontDebugSeen = new Set();
const textLayoutCache = new WeakMap();

const timelineHoverSec = {
  zoom: 0,
  text: 0,
};

let editingEffect = null;
let resizingEffect = null;
let effectEditorAnchorPoint = null;
let suppressNextSegmentClick = false;
let draftPersistTimer = 0;
let lastPointerClientX = 0;
let lastPointerClientY = 0;
let lastHoveredSegmentRef = null;

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
  cursorMotionMode: "raw",
  cursorSplineGuideHz: 18,
  aspectPreset: "source",
  trimStartSec: 0,
  trimEndSec: 0,
  renderFrameTransport: "png",
  renderFpsMode: "source",
  renderFpsValue: 60,
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
  const mediaSec = Number(videoEl.currentTime || 0);
  const trimmedSec = mediaToTrimmedSec(mediaSec, videoEl.duration);
  const curNow = uiCurrentSec(trimmedSec);
  const cur = dur > 0 ? Math.min(curNow, dur) : curNow;

  if (!isSeeking) {
    if (dur > 0) seekBar.value = String(Math.round((cur / dur) * 1000));
    else seekBar.value = "0";
  }
  timeLabel.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
  playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
  updateTimelinePlayhead(mediaSec, timelineDurationSec());
}

function normalizeAspectPreset(value) {
  const key = String(value || "source");
  if (key === "source") return "source";
  return Object.prototype.hasOwnProperty.call(ASPECT_PRESET_VALUES, key) ? key : "source";
}

function activeAspectRatio(videoWidth, videoHeight) {
  const safeW = Math.max(1, Number(videoWidth || 0));
  const safeH = Math.max(1, Number(videoHeight || 0));
  const sourceAspect = safeW / safeH;
  const preset = normalizeAspectPreset(project.aspectPreset);
  if (preset === "source") return sourceAspect;
  return ASPECT_PRESET_VALUES[preset] || sourceAspect;
}

function syncAspectPresetUi() {
  if (!aspectPresetSelect) return;
  aspectPresetSelect.value = normalizeAspectPreset(project.aspectPreset);
}

function updateSourceAspectOptionLabel(videoWidth, videoHeight) {
  if (!aspectPresetSelect) return;
  const sourceOption = aspectPresetSelect.querySelector('option[value="source"]');
  if (!sourceOption) return;
  const vw = Number(videoWidth || 0);
  const vh = Number(videoHeight || 0);
  if (vw > 0 && vh > 0) sourceOption.textContent = `Source (${vw}x${vh})`;
  else sourceOption.textContent = "Source";
}

function selectedTextFontFamily(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Segoe UI";
  const patrickAliases = new Set([
    "Patrick Hand",
    "PatrickHand-Regular",
    "PatrickHand",
    "Patrick Hand Regular",
    "PatrickHand-Regular.ttf",
  ]);
  if (patrickAliases.has(raw)) return "Patrick Hand";
  return raw;
}

function textFontCssStack(value) {
  const family = selectedTextFontFamily(value);
  if (family === "Patrick Hand") {
    return "'Patrick Hand','PatrickHand-Regular','PatrickHand','Patrick Hand Regular','Segoe UI',sans-serif";
  }
  const escaped = family.replace(/'/g, "\\'");
  return `'${escaped}','Segoe UI',sans-serif`;
}

function installLocalPatrickFontAlias() {
  if (document.getElementById("patrick-font-alias-style")) return;
  const style = document.createElement("style");
  style.id = "patrick-font-alias-style";
  style.textContent = `
@font-face {
  font-family: "Patrick Hand";
  src: local("Patrick Hand"),
       local("PatrickHand-Regular"),
       local("PatrickHand"),
       local("Patrick Hand Regular");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
`;
  document.head.appendChild(style);
}

function resolveCanvasFontSpec(fontSize, value) {
  const family = selectedTextFontFamily(value);
  const px = Math.max(1, Math.round(Number(fontSize || 12)));
  const preferred = `${px}px '${family.replace(/'/g, "\\'")}'`;
  const canUsePreferred = Boolean(document.fonts?.check?.(preferred));
  if (canUsePreferred) return preferred;
  return `${px}px ${textFontCssStack(family)}`;
}

function debugLogTextFontUsage(source, textEffect, requestedFontSpec, actualFontSpec = "") {
  if (!DEBUG_TEXT_FONT) return;
  const key = [
    source,
    String(textEffect?.startSec ?? ""),
    String(textEffect?.endSec ?? ""),
    String(textEffect?.value ?? ""),
    String(textEffect?.fontFamily ?? ""),
    requestedFontSpec,
    actualFontSpec,
  ].join("|");
  if (textFontDebugSeen.has(key)) return;
  textFontDebugSeen.add(key);
  console.log("[text-font-debug]", {
    source,
    rawFontFamily: textEffect?.fontFamily,
    normalizedFontFamily: selectedTextFontFamily(textEffect?.fontFamily),
    requestedFontSpec,
    actualFontSpec,
    text: textEffect?.value,
    startSec: textEffect?.startSec,
    endSec: textEffect?.endSec,
  });
}

function textFontOptionsHtml(selectedValue) {
  const active = selectedTextFontFamily(selectedValue);
  let options = TEXT_FONT_OPTIONS.map((opt) => {
    const isSelected = opt.value === active ? " selected" : "";
    const escaped = opt.value.replace(/"/g, "&quot;");
    return `<option value="${escaped}" style="font-family:${textFontCssStack(opt.value)}"${isSelected}>${opt.label}</option>`;
  });
  if (!TEXT_FONT_OPTIONS.some((opt) => opt.value === active)) {
    const escaped = active.replace(/"/g, "&quot;");
    options = [`<option value="${escaped}" style="font-family:${textFontCssStack(active)}" selected>${escaped}</option>`, ...options];
  }
  return options.join("");
}

function normalizedTextTransition(value) {
  const raw = String(value || "none");
  if (raw === "grow-in" || raw === "grow-out") return "grow";
  return TEXT_TRANSITION_OPTIONS.some((opt) => opt.value === raw) ? raw : "none";
}

function textTransitionOptionsHtml(selectedValue) {
  const active = normalizedTextTransition(selectedValue);
  return TEXT_TRANSITION_OPTIONS.map((opt) => {
    const isSelected = opt.value === active ? " selected" : "";
    return `<option value="${opt.value}"${isSelected}>${opt.label}</option>`;
  }).join("");
}

function sourceDurationSecFor(sourceDuration) {
  const videoDuration = Number(sourceDuration || 0);
  const projectDuration = Number(project.durationSec || 0);
  if (videoDuration > 0 && projectDuration > 0) return Math.min(videoDuration, projectDuration);
  return Math.max(videoDuration, projectDuration, 0);
}

function trimRangeForDuration(sourceDuration) {
  const maxSec = Math.max(0, Number(sourceDuration || 0));
  const start = Math.max(0, Math.min(maxSec, Number(project.trimStartSec || 0)));
  const endRaw = Number(project.trimEndSec || 0);
  const end = endRaw > 0 ? Math.max(start, Math.min(maxSec, endRaw)) : maxSec;
  return { startSec: start, endSec: end, durationSec: Math.max(0, end - start) };
}

function normalizeTrimBoundsForDuration(sourceDuration) {
  const range = trimRangeForDuration(sourceDuration);
  const nextStart = Number(range.startSec.toFixed(3));
  const nextEnd = Number(range.endSec.toFixed(3));
  if (Math.abs(Number(project.trimStartSec || 0) - nextStart) > 0.0005) project.trimStartSec = nextStart;
  if (Math.abs(Number(project.trimEndSec || 0) - nextEnd) > 0.0005) project.trimEndSec = nextEnd;
  return range;
}

function effectiveDurationSecFor(sourceDuration) {
  return trimRangeForDuration(sourceDurationSecFor(sourceDuration)).durationSec;
}

function effectiveDurationSec() {
  return effectiveDurationSecFor(videoEl.duration);
}

function mediaToTrimmedSec(mediaSec, sourceDuration = videoEl.duration) {
  const range = trimRangeForDuration(sourceDurationSecFor(sourceDuration));
  const media = Math.max(range.startSec, Math.min(range.endSec, Number(mediaSec || 0)));
  return Math.max(0, media - range.startSec);
}

function trimmedToMediaSec(trimmedSec, sourceDuration = videoEl.duration) {
  const range = trimRangeForDuration(sourceDurationSecFor(sourceDuration));
  const t = Math.max(0, Math.min(range.durationSec, Number(trimmedSec || 0)));
  return range.startSec + t;
}

function clampPlaybackToEffectiveDuration() {
  if (!videoEl.src) return;
  const range = trimRangeForDuration(sourceDurationSecFor(videoEl.duration));
  if (!(range.durationSec > 0)) return;
  const current = Number(videoEl.currentTime || 0);
  if (current < range.startSec) {
    videoEl.currentTime = range.startSec;
    videoEl.pause();
    return;
  }
  if (current > range.endSec) {
    videoEl.currentTime = range.endSec;
    videoEl.pause();
  }
}

function formatSec(ms) {
  return (ms / 1000).toFixed(2);
}

function timelineDurationSec() {
  const mediaDur = sourceDurationSecFor(videoEl.duration);
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
  effectEditor.style.left = `${Math.round(leftPx)}px`;
  effectEditor.style.top = `${Math.round(topPx)}px`;
}

function toggleCursorPopover(show) {
  if (!cursorPopover) return;
  if (show) cursorPopover.classList.remove("hidden");
  else cursorPopover.classList.add("hidden");
}

function normalizeCursorMotionMode(value) {
  const raw = String(value || "raw");
  if (raw === "smooth") return "spline";
  if (raw === "linear" || raw === "spline") return raw;
  return "raw";
}

function syncCursorMotionModeUi() {
  if (!cursorMotionModeSelect) return;
  cursorMotionModeSelect.value = normalizeCursorMotionMode(project.cursorMotionMode);
  if (cursorSplineGuideHzInput) {
    cursorSplineGuideHzInput.value = String(normalizeCursorSplineGuideHz(project.cursorSplineGuideHz));
    const splineMode = normalizeCursorMotionMode(project.cursorMotionMode) === "spline";
    cursorSplineGuideHzInput.disabled = !splineMode;
  }
}

function normalizeCursorSplineGuideHz(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 18;
  return Math.max(2, Math.min(60, Math.round(n)));
}

function legacySmoothStrengthToGuideHz(value) {
  const s = Number(value);
  if (!Number.isFinite(s)) return 18;
  return normalizeCursorSplineGuideHz(2 + (58 * Math.max(0, Math.min(100, s)) / 100));
}

function toggleRenderSettingsPopover(show) {
  if (!renderSettingsPopover) return;
  if (show) renderSettingsPopover.classList.remove("hidden");
  else renderSettingsPopover.classList.add("hidden");
}

function normalizeRenderFrameTransport(value) {
  const raw = String(value || "png").toLowerCase();
  return raw === "jpeg" ? "jpeg" : "png";
}

function normalizeRenderFpsMode(value) {
  return String(value || "source") === "custom" ? "custom" : "source";
}

function normalizeRenderFpsValue(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.max(1, Math.min(240, raw));
}

function syncRenderSettingsUi() {
  if (renderTransportSelect) {
    renderTransportSelect.value = normalizeRenderFrameTransport(project.renderFrameTransport);
  }
  if (renderFpsModeSelect) {
    renderFpsModeSelect.value = normalizeRenderFpsMode(project.renderFpsMode);
  }
  if (renderFpsValueInput) {
    renderFpsValueInput.value = String(normalizeRenderFpsValue(project.renderFpsValue));
    renderFpsValueInput.disabled = normalizeRenderFpsMode(project.renderFpsMode) !== "custom";
  }
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
      <label>Text<textarea data-key="value" rows="3">${String(effect.value || "").replace(/</g, "&lt;")}</textarea></label>
      <div class="row">
        <button type="button" class="ghost-btn" data-action="centerText">Center Text</button>
      </div>
      <div class="grid2">
        <label>Font Size (px)<input data-key="fontSize" type="number" min="8" max="200" step="1" value="${Math.round(Number(effect.fontSize || 22))}" /></label>
        <label>Font<select data-key="fontFamily">${textFontOptionsHtml(effect.fontFamily)}</select></label>
        <label>Transition<select data-key="transition">${textTransitionOptionsHtml(effect.transition)}</select></label>
        <label>Smooth (ms)<input data-key="smoothMs" type="number" min="0" max="5000" step="10" value="${Math.round(Number(effect.smoothMs ?? 0))}" /></label>
      </div>
      <div class="grid2">
        <label>Bold<input data-key="fontWeight" type="checkbox" ${String(effect.fontWeight || "normal") === "bold" ? "checked" : ""} /></label>
        <label>Italic<input data-key="fontStyle" type="checkbox" ${String(effect.fontStyle || "normal") === "italic" ? "checked" : ""} /></label>
        <label>Color<input data-key="color" type="color" value="${effect.color || "#ffffff"}" /></label>
        <label>Background<input data-key="bgColor" type="color" value="${effect.bgColor || "#000000"}" /></label>
        <label>BG Alpha (%)<input data-key="bgOpacity" type="range" min="0" max="100" step="1" value="${Math.round(Number(effect.bgOpacity ?? 68))}" /></label>
        <label>BG Alpha Value<input data-key="bgOpacity" type="number" min="0" max="100" step="1" value="${Math.round(Number(effect.bgOpacity ?? 68))}" /></label>
      </div>
    `;
  }

  for (const input of effectEditorFields.querySelectorAll("input, select, textarea")) {
    const onFieldChange = () => {
      const active = editingEffect?.effect;
      if (!active) return;
      const key = input.dataset.key;
      if (!key) return;
      if (key === "fontWeight") {
        active.fontWeight = input.checked ? "bold" : "normal";
      } else if (key === "fontStyle") {
        active.fontStyle = input.checked ? "italic" : "normal";
      } else if (key === "value" || key === "color" || key === "bgColor" || key === "fontFamily" || key === "transition") {
        active[key] = String(input.value || "");
      } else {
        active[key] = Number(input.value || 0);
      }
      if (kind === "zoom") {
        active.scale = Math.max(1, Number(active.scale || 1));
        active.easeMs = Math.max(0, Number(active.easeMs || 0));
      } else {
        active.xPct = Math.max(0, Math.min(100, Number(active.xPct || 0)));
        active.yPct = Math.max(0, Math.min(100, Number(active.yPct || 0)));
        active.bgOpacity = Math.max(0, Math.min(100, Number(active.bgOpacity ?? 68)));
        active.fontFamily = selectedTextFontFamily(active.fontFamily);
        active.fontWeight = String(active.fontWeight || "normal") === "bold" ? "bold" : "normal";
        active.fontStyle = String(active.fontStyle || "normal") === "italic" ? "italic" : "normal";
        active.transition = normalizedTextTransition(active.transition);
        active.smoothMs = Math.max(0, Math.min(5000, Number(active.smoothMs || 0)));
        if (key === "fontFamily" && DEBUG_TEXT_FONT) {
          if (document.fonts?.load) {
            document.fonts.load(`16px '${active.fontFamily.replace(/'/g, "\\'")}'`).catch(() => {});
          }
          console.log("[text-font-debug] font picker change", {
            selected: input.value,
            normalized: active.fontFamily,
            cssStack: textFontCssStack(active.fontFamily),
            requestedSpec: resolveCanvasFontSpec(16, active.fontFamily),
            checkPatrickHand: document.fonts?.check?.("16px 'Patrick Hand'") ?? null,
            checkPatrickHandRegular: document.fonts?.check?.("16px 'PatrickHand-Regular'") ?? null,
          });
        }
        const fontSelect = effectEditorFields.querySelector('select[data-key="fontFamily"]');
        if (fontSelect) fontSelect.style.fontFamily = textFontCssStack(active.fontFamily);
        if (key === "bgOpacity") {
          const synced = String(Math.round(Number(active.bgOpacity ?? 68)));
          for (const peer of effectEditorFields.querySelectorAll('input[data-key="bgOpacity"]')) {
            if (peer !== input) peer.value = synced;
          }
        }
      }
      clampEffectBounds(active);
      sortEffects();
      editingEffect.index = effectsFor(kind).indexOf(active);
      renderEffectsTimeline();
      syncPlaybackUi();
      queueDraftProjectPersist();
    };
    input.addEventListener("input", onFieldChange);
    input.addEventListener("change", onFieldChange);
  }

  if (kind === "text") {
    const fontSelect = effectEditorFields.querySelector('select[data-key="fontFamily"]');
    if (fontSelect) fontSelect.style.fontFamily = textFontCssStack(effect.fontFamily);
  }

  for (const btn of effectEditorFields.querySelectorAll("button[data-action]")) {
    btn.addEventListener("click", () => {
      const active = editingEffect?.effect;
      if (!active || kind !== "text") return;
      const action = btn.dataset.action;
      if (action !== "centerText") return;
      active.xPct = 50;
      active.yPct = 50;
      active.align = "center";
      const xInput = effectEditorFields.querySelector('input[data-key="xPct"]');
      const yInput = effectEditorFields.querySelector('input[data-key="yPct"]');
      if (xInput) xInput.value = "50";
      if (yInput) yInput.value = "50";
      renderEffectsTimeline();
      syncPlaybackUi();
      queueDraftProjectPersist();
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
  queueDraftProjectPersist();
  return true;
}

function deleteSelectedEffect() {
  if (!editingEffect) return false;
  const list = effectsFor(editingEffect.kind);
  const idx = list.indexOf(editingEffect.effect);
  if (idx < 0) return false;
  return deleteEffect(editingEffect.kind, idx);
}

function activeSegmentForCopy() {
  if (editingEffect?.effect && (editingEffect.kind === "zoom" || editingEffect.kind === "text")) {
    const idx = effectsFor(editingEffect.kind).indexOf(editingEffect.effect);
    if (idx >= 0) return { kind: editingEffect.kind, index: idx, effect: editingEffect.effect };
  }
  if (lastHoveredSegmentRef && (lastHoveredSegmentRef.kind === "zoom" || lastHoveredSegmentRef.kind === "text")) {
    const list = effectsFor(lastHoveredSegmentRef.kind);
    const effect = list[lastHoveredSegmentRef.index];
    if (effect) return { kind: lastHoveredSegmentRef.kind, index: lastHoveredSegmentRef.index, effect };
  }
  return null;
}

function copySelectedEffectToClipboard() {
  const selected = activeSegmentForCopy();
  if (!selected) {
    setStatus("Select or hover a zoom/text segment to copy.");
    return false;
  }
  const payload = {
    kind: selected.kind,
    effect: JSON.parse(JSON.stringify(selected.effect)),
    copiedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(EFFECT_CLIPBOARD_STORAGE_KEY, JSON.stringify(payload));
    setStatus(`Copied ${selected.kind} effect.`);
    return true;
  } catch {
    setStatus("Failed to copy effect.");
    return false;
  }
}

function readEffectClipboard() {
  try {
    const raw = window.localStorage.getItem(EFFECT_CLIPBOARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.kind !== "zoom" && parsed.kind !== "text") || !parsed.effect) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mediaTimeFromClientX(trackEl, clientX) {
  const rect = trackEl.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return p * timelineDurationSec();
}

function pasteEffectFromClipboardAtPointer() {
  const clipboard = readEffectClipboard();
  if (!clipboard) {
    setStatus("Clipboard is empty. Copy a zoom/text effect first.");
    return false;
  }
  const { kind } = clipboard;
  const list = effectsFor(kind);
  const source = JSON.parse(JSON.stringify(clipboard.effect));
  const trackEl = kind === "zoom" ? zoomTrack : textTrack;
  if (!trackEl || !list) return false;

  const start = Number(source.startSec || 0);
  const end = Math.max(start, Number(source.endSec || 0));
  const duration = Math.max(MIN_EFFECT_DURATION_SEC, end - start);
  const maxDur = timelineDurationSec();
  const atSec = mediaTimeFromClientX(trackEl, lastPointerClientX);
  const nextStart = Math.max(0, Math.min(Math.max(0, maxDur - duration), atSec));
  const clone = {
    ...source,
    startSec: nextStart,
    endSec: nextStart + duration,
  };
  list.push(clone);
  sortEffects();
  renderEffectsTimeline();
  syncPlaybackUi();
  queueDraftProjectPersist();
  setStatus(`Pasted ${kind} effect.`);
  return true;
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

function renderTrimSegment(trackEl, durSec) {
  if (!trackEl) return;
  const range = normalizeTrimBoundsForDuration(sourceDurationSecFor(videoEl.duration));
  const seg = createTimelineSegment("trim", range.startSec, range.endSec, "Active Range", Math.max(durSec, 0.001));
  if (!seg) return;
  seg.dataset.kind = "trim";
  seg.title = `Trim (${range.startSec.toFixed(2)}s - ${range.endSec.toFixed(2)}s)`;
  seg.innerHTML = `<span class="timeline-segment-label">Active Range</span>
    <span class="timeline-handle left" data-side="left"></span>
    <span class="timeline-handle right" data-side="right"></span>`;
  trackEl.appendChild(seg);
}

function renderEffectsTimeline() {
  if (!trimTrack || !zoomTrack || !textTrack) return;
  if (zoomAddBtn && zoomAddBtn.parentElement !== zoomTrack) zoomTrack.appendChild(zoomAddBtn);
  if (textAddBtn && textAddBtn.parentElement !== textTrack) textTrack.appendChild(textAddBtn);
  for (const el of trimTrack.querySelectorAll(".timeline-segment")) el.remove();
  for (const el of zoomTrack.querySelectorAll(".timeline-segment")) el.remove();
  for (const el of textTrack.querySelectorAll(".timeline-segment")) el.remove();
  const durSec = timelineDurationSec();

  renderTrimSegment(trimTrack, durSec);
  buildTrackSegments("zoom", zoomTrack, durSec);
  buildTrackSegments("text", textTrack, durSec);

  const cur = Number(videoEl.currentTime || 0);
  const mediaDur = sourceDurationSecFor(videoEl.duration);
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

function evenFloor(value) {
  const n = Math.max(2, Math.floor(Number(value || 0)));
  return n % 2 === 0 ? n : n - 1;
}

function outputDimensionsForSource(sourceW, sourceH) {
  const safeW = Math.max(2, Math.round(Number(sourceW || 0)));
  const safeH = Math.max(2, Math.round(Number(sourceH || 0)));
  const targetAspect = activeAspectRatio(safeW, safeH);
  const sourceAspect = safeW / safeH;
  let outW = safeW;
  let outH = safeH;

  if (Math.abs(targetAspect - sourceAspect) > 0.0001) {
    if (targetAspect > sourceAspect) outH = Math.max(2, Math.round(safeW / targetAspect));
    else outW = Math.max(2, Math.round(safeH * targetAspect));
  }

  return {
    width: evenFloor(outW),
    height: evenFloor(outH),
  };
}

function aspectViewportForSource(sourceW, sourceH) {
  const safeW = Math.max(1, Number(sourceW || 0));
  const safeH = Math.max(1, Number(sourceH || 0));
  const targetAspect = activeAspectRatio(safeW, safeH);
  const sourceAspect = safeW / safeH;
  if (Math.abs(targetAspect - sourceAspect) <= 0.0001) {
    return {
      sx: 0,
      sy: 0,
      sw: safeW,
      sh: safeH,
    };
  }

  let sw = safeW;
  let sh = safeH;
  if (targetAspect > sourceAspect) sh = safeW / targetAspect;
  else sw = safeH * targetAspect;
  const sx = (safeW - sw) / 2;
  const sy = (safeH - sh) / 2;

  return { sx, sy, sw, sh };
}

function syncPreviewStageAspect() {
  const vw = Number(videoEl.videoWidth || 0);
  const vh = Number(videoEl.videoHeight || 0);
  if (!previewStageEl || !previewViewportEl || vw <= 0 || vh <= 0) return;
  const outputDims = outputDimensionsForSource(vw, vh);

  // Fit stage strictly inside viewport rect (contain; never clip, never overlap controls).
  const viewportW = Math.max(1, Number(previewViewportEl.clientWidth || 1));
  const viewportH = Math.max(1, Number(previewViewportEl.clientHeight || 1));
  const scale = Math.min(viewportW / outputDims.width, viewportH / outputDims.height);
  const targetW = Math.max(1, Math.floor(outputDims.width * scale));
  const targetH = Math.max(1, Math.floor(outputDims.height * scale));

  previewStageEl.style.aspectRatio = `${outputDims.width} / ${outputDims.height}`;
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
      cursorMotionMode: normalizeCursorMotionMode(project.cursorMotionMode),
      cursorSplineGuideHz: normalizeCursorSplineGuideHz(project.cursorSplineGuideHz),
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
    project.cursorMotionMode = normalizeCursorMotionMode(data.cursorMotionMode);
    project.cursorSplineGuideHz = data.cursorSplineGuideHz != null
      ? normalizeCursorSplineGuideHz(data.cursorSplineGuideHz)
      : legacySmoothStrengthToGuideHz(data.cursorSmoothStrength);
    project.cursorTextureName = String(data.cursorTextureName || "");
    cursorOffsetXInput.value = String(project.cursorOffsetX);
    cursorOffsetYInput.value = String(project.cursorOffsetY);
    if (cursorSplineGuideHzInput) {
      cursorSplineGuideHzInput.value = String(project.cursorSplineGuideHz);
    }
    syncCursorMotionModeUi();
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
    queueDraftProjectPersist();
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
  queueDraftProjectPersist();
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

function textBgRgba(t) {
  const hex = t.bgColor || "#000000";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = (Number(t.bgOpacity ?? 68) / 100).toFixed(2);
  return `rgba(${r},${g},${b},${a})`;
}

function textTransitionState(t, tSec) {
  const transition = normalizedTextTransition(t.transition);
  const smoothMs = Math.max(0, Number(t.smoothMs || 0));
  const smoothSec = smoothMs / 1000;
  let alpha = 1;
  let scale = 1;
  if (transition === "none" || smoothSec <= 0) return { alpha, scale };

  const inProgress = Math.max(0, Math.min(1, (tSec - Number(t.startSec || 0)) / smoothSec));
  const outProgress = Math.max(0, Math.min(1, (Number(t.endSec || 0) - tSec) / smoothSec));

  if (transition === "grow") {
    if (tSec < Number(t.startSec || 0) + smoothSec) scale = inProgress;
    if (tSec > Number(t.endSec || 0) - smoothSec) scale = Math.min(scale, outProgress);
  } else if (transition === "fade") {
    if (tSec < Number(t.startSec || 0) + smoothSec) alpha = inProgress;
    if (tSec > Number(t.endSec || 0) - smoothSec) alpha = Math.min(alpha, outProgress);
  }
  return { alpha, scale };
}

function textBoxMetrics(renderCtx, textValue, fontSize, pad) {
  const lines = String(textValue ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const safeLines = lines.length ? lines : [""];
  const sampleMetrics = renderCtx.measureText("Mg");
  const ascent = Number(sampleMetrics.actualBoundingBoxAscent || fontSize * 0.78);
  const descentRaw = Number(sampleMetrics.actualBoundingBoxDescent || fontSize * 0.24);
  const descent = Math.min(descentRaw, fontSize * 0.34);
  let width = 0;
  for (const line of safeLines) {
    width = Math.max(width, Number(renderCtx.measureText(line).width || 0));
  }
  const lineHeight = Math.max(fontSize * 1.16, ascent + descent + 1);
  const textBlockH = ascent + descent + Math.max(0, safeLines.length - 1) * lineHeight;
  const padX = pad;
  const padTop = pad;
  const padBottom = Math.max(4, Math.round(pad * 0.55));
  const boxW = width + padX * 2;
  const boxH = textBlockH + padTop + padBottom;
  const baselineY = 0;
  const boxY = baselineY - ascent - padTop;
  return { boxW, boxH, boxY, ascent, descent, padX, padTop, padBottom, lines: safeLines, lineHeight };
}

function textBoxMetricsCached(renderCtx, textEffect, requestedFontSpec, fontSize, pad) {
  const value = String(textEffect?.value ?? "");
  const fontKey = String(renderCtx.font || requestedFontSpec || "");
  const key = `${fontKey}|${fontSize}|${pad}|${value}`;
  const cached = textLayoutCache.get(textEffect);
  if (cached && cached.key === key) return cached.metrics;
  const metrics = textBoxMetrics(renderCtx, value, fontSize, pad);
  textLayoutCache.set(textEffect, { key, metrics });
  return metrics;
}

function drawTextOverlays(currentMs) {
  const tSec = currentMs / 1000;
  for (const t of project.texts) {
    if (tSec < t.startSec || tSec > t.endSec) continue;

    const x = (t.xPct / 100) * canvas.width;
    const y = (t.yPct / 100) * canvas.height;
    const fontSize = Number(t.fontSize || 22);
    const align = t.align === "center" ? "center" : "left";
    const fontFamily = selectedTextFontFamily(t.fontFamily);
    const fontWeight = String(t.fontWeight || "normal") === "bold" ? "bold" : "normal";
    const fontStyle = String(t.fontStyle || "normal") === "italic" ? "italic" : "normal";
    const transitionState = textTransitionState(t, tSec);

    const pad = 10;
    const requestedFontSpec = `${fontStyle} ${fontWeight} ${resolveCanvasFontSpec(fontSize, fontFamily)}`.trim();
    ctx.save();
    ctx.globalAlpha = transitionState.alpha;
    ctx.translate(x, y);
    ctx.font = requestedFontSpec;
    debugLogTextFontUsage("preview", t, requestedFontSpec, ctx.font);
    ctx.textAlign = align;
    const { boxW: w, boxH: h, boxY, lines, lineHeight } = textBoxMetricsCached(
      ctx,
      t,
      requestedFontSpec,
      fontSize,
      pad
    );
    const bgX = align === "center" ? -w / 2 : -pad;
    const pivotX = bgX + w / 2;
    const pivotY = boxY + h / 2;
    ctx.translate(pivotX, pivotY);
    ctx.scale(transitionState.scale, transitionState.scale);
    ctx.translate(-pivotX, -pivotY);

    ctx.fillStyle = textBgRgba(t);
    const bgRadius = Math.max(0, Math.min(14, h * 0.35));
    ctx.beginPath();
    ctx.roundRect(bgX, boxY, w, h, bgRadius);
    ctx.fill();
    ctx.fillStyle = t.color || "#ffffff";
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], 0, i * lineHeight);
    }
    ctx.restore();
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

function isPointerEventType(type) {
  return type === "mouse_move" || type === "mouse_down" || type === "mouse_up";
}

const cursorSplineTrackCache = {
  key: "",
  anchors: [],
};

function findPrevPointerEventIndex(evts, startIndex) {
  for (let i = Math.max(0, Number(startIndex || 0)); i >= 0; i -= 1) {
    if (isPointerEventType(evts[i]?.type)) return i;
  }
  return -1;
}

function findNextPointerEventIndex(evts, startIndex) {
  for (let i = Math.max(0, Number(startIndex || 0)); i < evts.length; i += 1) {
    if (isPointerEventType(evts[i]?.type)) return i;
  }
  return -1;
}

function tryPinnedClickPosition(currentMs, centerIdx, evts, toPos) {
  const CLICK_PIN_MS = 6;
  const lo = Math.max(0, centerIdx - 10);
  const hi = Math.min(evts.length - 1, centerIdx + 10);
  for (let i = lo; i <= hi; i += 1) {
    const evt = evts[i];
    if (evt?.type !== "mouse_down" && evt?.type !== "mouse_up") continue;
    const dt = Math.abs(Number(evt.t || 0) - currentMs);
    if (dt > CLICK_PIN_MS) continue;
    if (evt.inFrame === false) continue;
    const pos = toPos(evt);
    if (!pos) continue;
    return { inFrame: true, x: pos.x, y: pos.y };
  }
  return null;
}

function normalizedPointerFromEvent(evt) {
  const xr = eventRatio(evt, "x");
  const yr = eventRatio(evt, "y");
  if (xr != null && yr != null) {
    return { x: xr, y: yr };
  }
  const b = project.captureBounds;
  if (
    b
    && Number.isFinite(Number(evt?.x))
    && Number.isFinite(Number(evt?.y))
    && Number(b.width) > 0
    && Number(b.height) > 0
  ) {
    const nx = (Number(evt.x) - Number(b.x || 0)) / Number(b.width);
    const ny = (Number(evt.y) - Number(b.y || 0)) / Number(b.height);
    return { x: clamp01(nx), y: clamp01(ny) };
  }
  return null;
}

function cursorSplineCacheKey(guideHz) {
  const evts = project.events;
  const last = evts.length ? evts[evts.length - 1] : null;
  const cb = project.captureBounds || {};
  return [
    normalizeCursorSplineGuideHz(guideHz),
    evts.length,
    Number(last?.t || 0).toFixed(3),
    Number(cb.x || 0),
    Number(cb.y || 0),
    Number(cb.width || 0),
    Number(cb.height || 0),
  ].join("|");
}

function pushSplineAnchor(anchors, t, x, y, isClick = false) {
  const tx = Number(t || 0);
  const ax = clamp01(Number(x || 0));
  const ay = clamp01(Number(y || 0));
  if (!anchors.length) {
    anchors.push({ t: tx, x: ax, y: ay, click: Boolean(isClick) });
    return;
  }
  const last = anchors[anchors.length - 1];
  if (Math.abs(Number(last.t) - tx) < 0.0001) {
    if (isClick || !last.click) {
      last.t = tx;
      last.x = ax;
      last.y = ay;
      last.click = Boolean(isClick);
    }
    return;
  }
  anchors.push({ t: tx, x: ax, y: ay, click: Boolean(isClick) });
}

function getSplineCursorAnchors(guideHz) {
  const key = cursorSplineCacheKey(guideHz);
  if (cursorSplineTrackCache.key === key) return cursorSplineTrackCache.anchors;

  const evts = project.events;
  const anchors = [];
  const stepMs = 1000 / Math.max(1, normalizeCursorSplineGuideHz(guideHz));
  let nextGuideT = Number.NEGATIVE_INFINITY;
  let lastPointer = null;

  for (let i = 0; i < evts.length; i += 1) {
    const evt = evts[i];
    if (!isPointerEventType(evt?.type)) continue;
    if (evt.inFrame === false) continue;
    const norm = normalizedPointerFromEvent(evt);
    if (!norm) continue;
    const t = Number(evt.t || 0);
    const isClick = evt.type === "mouse_down" || evt.type === "mouse_up";
    if (!anchors.length) {
      pushSplineAnchor(anchors, t, norm.x, norm.y, isClick);
      nextGuideT = t + stepMs;
      lastPointer = { t, x: norm.x, y: norm.y };
      continue;
    }
    if (isClick || t >= nextGuideT) {
      pushSplineAnchor(anchors, t, norm.x, norm.y, isClick);
      nextGuideT = t + stepMs;
    }
    lastPointer = { t, x: norm.x, y: norm.y };
  }
  if (lastPointer) {
    pushSplineAnchor(anchors, lastPointer.t, lastPointer.x, lastPointer.y, false);
  }

  cursorSplineTrackCache.key = key;
  cursorSplineTrackCache.anchors = anchors;
  return anchors;
}

function catmullRom1d(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3
  );
}

function splineNormAt(currentMs, guideHz) {
  const anchors = getSplineCursorAnchors(guideHz);
  if (!anchors.length) return null;
  let lo = 0;
  let hi = anchors.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid].t <= currentMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return { x: anchors[0].x, y: anchors[0].y };
  if (best >= anchors.length - 1) {
    const tail = anchors[anchors.length - 1];
    return { x: tail.x, y: tail.y };
  }
  const p1 = anchors[Math.max(0, best)];
  const p2 = anchors[Math.min(anchors.length - 1, best + 1)];
  const p0 = anchors[Math.max(0, best - 1)];
  const p3 = anchors[Math.min(anchors.length - 1, best + 2)];
  if (Number(p2.t) <= Number(p1.t)) return { x: p1.x, y: p1.y };
  const p = Math.max(0, Math.min(1, (currentMs - Number(p1.t)) / (Number(p2.t) - Number(p1.t))));
  return {
    x: clamp01(catmullRom1d(p0.x, p1.x, p2.x, p3.x, p)),
    y: clamp01(catmullRom1d(p0.y, p1.y, p2.y, p3.y, p)),
  };
}

function resolveCursorPointerAt(currentMs, toPos, fromNorm, fallbackPointer) {
  const mode = normalizeCursorMotionMode(project.cursorMotionMode);
  const evts = project.events;
  const hi = bisectEvents(currentMs);
  const prevIdx = findPrevPointerEventIndex(evts, hi);
  if (prevIdx < 0) return fallbackPointer();
  const prevEvt = evts[prevIdx];
  if (prevEvt.inFrame === false) return fallbackPointer();
  const prevPos = toPos(prevEvt);
  if (!prevPos) return fallbackPointer();
  const pinnedClickPos = tryPinnedClickPosition(currentMs, prevIdx, evts, toPos);
  if (pinnedClickPos) return pinnedClickPos;
  if (mode === "raw") return { inFrame: true, x: prevPos.x, y: prevPos.y };

  const nextIdx = findNextPointerEventIndex(evts, prevIdx + 1);
  const nextEvt = nextIdx >= 0 ? evts[nextIdx] : null;
  let linear = { inFrame: true, x: prevPos.x, y: prevPos.y };
  if (
    nextEvt
    && nextEvt.inFrame !== false
    && Number(nextEvt.t) > Number(prevEvt.t)
  ) {
    const nextPos = toPos(nextEvt);
    if (nextPos) {
      const p = Math.max(0, Math.min(1, (currentMs - Number(prevEvt.t || 0)) / (Number(nextEvt.t || 0) - Number(prevEvt.t || 0))));
      linear = {
        inFrame: true,
        x: prevPos.x + (nextPos.x - prevPos.x) * p,
        y: prevPos.y + (nextPos.y - prevPos.y) * p,
      };
    }
  }
  if (mode === "linear") return linear;
  const norm = splineNormAt(currentMs, project.cursorSplineGuideHz);
  if (!norm) return linear;
  const pos = fromNorm(norm);
  return pos ? { inFrame: true, x: pos.x, y: pos.y } : linear;
}

function pointerAt(currentMs) {
  return resolveCursorPointerAt(
    currentMs,
    (evt) => eventToCanvasPosition(evt),
    (norm) => {
      const rect = videoContentRect();
      const ox = Number(project.cursorOffsetX || 0);
      const oy = Number(project.cursorOffsetY || 0);
      return {
        x: rect.x + norm.x * rect.width + ox,
        y: rect.y + norm.y * rect.height + oy,
      };
    },
    () => {
      const rect = videoContentRect();
      return { inFrame: false, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  );
}

/** Binary-search for the index of the last event with t <= ms. Returns -1 if none. */
function bisectEvents(ms) {
  const evts = project.events;
  let lo = 0;
  let hi = evts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (evts[mid].t <= ms) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function activeHoldsAt(currentMs) {
  const heldSince = { 0: null, 2: null };
  let found0 = false;
  let found2 = false;
  const evts = project.events;
  const start = bisectEvents(currentMs);
  for (let i = start; i >= 0; i -= 1) {
    const evt = evts[i];
    if (found0 && found2) break;
    if (evt.button !== 0 && evt.button !== 2) continue;
    if (evt.type === "mouse_up") {
      if (evt.button === 0 && !found0) { heldSince[0] = null; found0 = true; }
      if (evt.button === 2 && !found2) { heldSince[2] = null; found2 = true; }
    } else if (evt.type === "mouse_down") {
      if (evt.button === 0 && !found0) { heldSince[0] = evt.t; found0 = true; }
      if (evt.button === 2 && !found2) { heldSince[2] = evt.t; found2 = true; }
    }
  }
  return heldSince;
}

function lastKeyDownAt(currentMs) {
  const evts = project.events;
  const start = bisectEvents(currentMs);
  for (let i = start; i >= 0; i -= 1) {
    const evt = evts[i];
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
  return resolveCursorPointerAt(
    currentMs,
    (evt) => exportEventToPosition(evt, width, height),
    (norm) => {
      const ox = Number(project.cursorOffsetX || 0);
      const oy = Number(project.cursorOffsetY || 0);
      return {
        x: norm.x * width + ox,
        y: norm.y * height + oy,
      };
    },
    () => ({ inFrame: false, x: width / 2, y: height / 2 })
  );
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

function drawClickBurstsOn(renderCtx, currentMs, width, height, zoomViewport, range = null) {
  const life = 460;
  const evts = project.events;
  const hi = range ? Number(range.hi) : bisectEvents(currentMs);
  const lo = range ? Number(range.lo) : bisectEvents(currentMs - life);
  const startIdx = Math.max(0, lo);
  for (let i = startIdx; i <= hi; i += 1) {
    const evt = evts[i];
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

function drawHeldButtonsFromStateOn(renderCtx, currentMs, heldSince) {
  const holds = [];
  if (heldSince?.[0] != null) holds.push({ label: "L HOLD", downAt: heldSince[0] });
  if (heldSince?.[2] != null) holds.push({ label: "R HOLD", downAt: heldSince[2] });
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
    const fontSize = Number(t.fontSize || 22);
    const align = t.align === "center" ? "center" : "left";
    const fontFamily = selectedTextFontFamily(t.fontFamily);
    const fontWeight = String(t.fontWeight || "normal") === "bold" ? "bold" : "normal";
    const fontStyle = String(t.fontStyle || "normal") === "italic" ? "italic" : "normal";
    const transitionState = textTransitionState(t, tSec);
    const pad = 10;
    const requestedFontSpec = `${fontStyle} ${fontWeight} ${resolveCanvasFontSpec(fontSize, fontFamily)}`.trim();
    renderCtx.save();
    renderCtx.globalAlpha = transitionState.alpha;
    renderCtx.translate(x, y);
    renderCtx.font = requestedFontSpec;
    debugLogTextFontUsage("export", t, requestedFontSpec, renderCtx.font);
    renderCtx.textAlign = align;
    const { boxW: w, boxH: h, boxY, lines, lineHeight } = textBoxMetricsCached(
      renderCtx,
      t,
      requestedFontSpec,
      fontSize,
      pad
    );
    const bgX = align === "center" ? -w / 2 : -pad;
    const pivotX = bgX + w / 2;
    const pivotY = boxY + h / 2;
    renderCtx.translate(pivotX, pivotY);
    renderCtx.scale(transitionState.scale, transitionState.scale);
    renderCtx.translate(-pivotX, -pivotY);

    renderCtx.fillStyle = textBgRgba(t);
    const bgRadius = Math.max(0, Math.min(14, h * 0.35));
    renderCtx.beginPath();
    renderCtx.roundRect(bgX, boxY, w, h, bgRadius);
    renderCtx.fill();
    renderCtx.fillStyle = t.color || "#ffffff";
    for (let i = 0; i < lines.length; i += 1) {
      renderCtx.fillText(lines[i], 0, i * lineHeight);
    }
    renderCtx.restore();
  }
}

function drawKeyPillOn(renderCtx, currentMs, width) {
  const keyDown = lastKeyDownAt(currentMs);
  drawKeyPillEventOn(renderCtx, keyDown, currentMs, width);
}

function drawKeyPillEventOn(renderCtx, keyDown, currentMs, width) {
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

function collectFrameOverlayState(currentMs, width, height) {
  const evts = project.events;
  const hi = bisectEvents(currentMs);
  const heldSince = { 0: null, 2: null };
  let found0 = false;
  let found2 = false;
  let keyDown = null;
  let pointer = pointerAtForExport(currentMs, width, height);
  const minKeyMs = currentMs - 1000;

  for (let i = hi; i >= 0; i -= 1) {
    const evt = evts[i];
    if (!keyDown && evt.type === "key_down") keyDown = evt;

    if (!found0 || !found2) {
      if ((evt.type === "mouse_up" || evt.type === "mouse_down") && (evt.button === 0 || evt.button === 2)) {
        if (evt.button === 0 && !found0) {
          heldSince[0] = evt.type === "mouse_down" ? evt.t : null;
          found0 = true;
        } else if (evt.button === 2 && !found2) {
          heldSince[2] = evt.type === "mouse_down" ? evt.t : null;
          found2 = true;
        }
      }
    }

    if ((pointer && found0 && found2 && keyDown) || (pointer && found0 && found2 && evt.t < minKeyMs)) {
      break;
    }
  }

  return {
    pointer,
    heldSince,
    keyDown,
    clickHi: hi,
    clickLo: bisectEvents(currentMs - 460),
  };
}

function getZoomViewportAt(currentMs, pointer, width, height) {
  const aspectViewport = aspectViewportForSource(width, height);
  const factor = activeZoomAt(currentMs) || 1;
  const sw = aspectViewport.sw / factor;
  const sh = aspectViewport.sh / factor;
  let sx = (width - sw) / 2;
  let sy = (height - sh) / 2;

  if (pointer?.inFrame) {
    const px = Number(pointer.x || 0);
    const py = Number(pointer.y || 0);
    const deadX = Math.max(1, sw * CAMERA_DEADZONE_RATIO);
    const deadY = Math.max(1, sh * CAMERA_DEADZONE_RATIO);
    const leftEdge = sx + deadX;
    const rightEdge = sx + sw - deadX;
    const topEdge = sy + deadY;
    const bottomEdge = sy + sh - deadY;

    if (px < leftEdge) sx = px - deadX;
    else if (px > rightEdge) sx = px + deadX - sw;
    if (py < topEdge) sy = py - deadY;
    else if (py > bottomEdge) sy = py + deadY - sh;
  }

  sx = Math.max(0, Math.min(width - sw, sx));
  sy = Math.max(0, Math.min(height - sh, sy));

  if (factor <= 1.001) {
    return {
      factor: 1,
      sx,
      sy,
      sw,
      sh,
    };
  }

  return {
    factor,
    sx,
    sy,
    sw,
    sh,
  };
}

function mapPointThroughViewport(point, zoomViewport, width, height) {
  if (!zoomViewport) return point;
  const isIdentity = isIdentityViewport(zoomViewport, width, height);
  if (isIdentity) return point;
  const mapped = {
    x: ((point.x - zoomViewport.sx) * width) / zoomViewport.sw,
    y: ((point.y - zoomViewport.sy) * height) / zoomViewport.sh,
  };
  return {
    x: Math.max(0, Math.min(width, mapped.x)),
    y: Math.max(0, Math.min(height, mapped.y)),
  };
}

function isIdentityViewport(zoomViewport, width, height) {
  if (!zoomViewport) return true;
  return Math.abs(Number(zoomViewport.sx || 0)) <= 0.001
    && Math.abs(Number(zoomViewport.sy || 0)) <= 0.001
    && Math.abs(Number(zoomViewport.sw || width) - width) <= 0.001
    && Math.abs(Number(zoomViewport.sh || height) - height) <= 0.001;
}

function sourceDimensions(sourceLike, fallbackW, fallbackH) {
  const w = Math.max(1, Number(
    sourceLike?.videoWidth
    || sourceLike?.naturalWidth
    || sourceLike?.width
    || fallbackW
    || 1
  ));
  const h = Math.max(1, Number(
    sourceLike?.videoHeight
    || sourceLike?.naturalHeight
    || sourceLike?.height
    || fallbackH
    || 1
  ));
  return { width: w, height: h };
}

function createGpuZoomRenderer() {
  const canvasEl = document.createElement("canvas");
  const gl = canvasEl.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return null;

  gl.shaderSource(vertexShader, `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = (aPos + 1.0) * 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `);
  gl.compileShader(vertexShader);
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) return null;

  gl.shaderSource(fragmentShader, `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform vec4 uSrcRect;
    void main() {
      vec2 topLeftUv = vec2(vUv.x, 1.0 - vUv.y);
      vec2 sampleUv = vec2(
        uSrcRect.x + topLeftUv.x * uSrcRect.z,
        uSrcRect.y + topLeftUv.y * uSrcRect.w
      );
      gl_FragColor = texture2D(uTex, sampleUv);
    }
  `);
  gl.compileShader(fragmentShader);
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const posLoc = gl.getAttribLocation(program, "aPos");
  const srcRectLoc = gl.getUniformLocation(program, "uSrcRect");
  if (posLoc < 0 || !srcRectLoc) return null;

  const positionBuffer = gl.createBuffer();
  const tex = gl.createTexture();
  if (!positionBuffer || !tex) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    1, 1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);

  return {
    canvas: canvasEl,
    gl,
    program,
    srcRectLoc,
    texture: tex,
  };
}

function ensureGpuZoomRenderer(width, height) {
  if (!GPU_ZOOM_COMPOSITE_ENABLED || gpuZoomDisabled) return null;
  if (!gpuZoomRenderer) {
    gpuZoomRenderer = createGpuZoomRenderer();
    if (!gpuZoomRenderer) {
      gpuZoomDisabled = true;
      return null;
    }
  }
  const w = Math.max(1, Math.round(Number(width || 0)));
  const h = Math.max(1, Math.round(Number(height || 0)));
  if (gpuZoomRenderer.canvas.width !== w) gpuZoomRenderer.canvas.width = w;
  if (gpuZoomRenderer.canvas.height !== h) gpuZoomRenderer.canvas.height = h;
  return gpuZoomRenderer;
}

function drawZoomedVideoGpu(renderCtx, sourceLike, zoomViewport, width, height) {
  const renderer = ensureGpuZoomRenderer(width, height);
  if (!renderer || !zoomViewport) return false;
  const sourceSize = sourceDimensions(sourceLike, width, height);
  const sourceW = sourceSize.width;
  const sourceH = sourceSize.height;
  if (isIdentityViewport(zoomViewport, sourceW, sourceH)) return false;

  const gl = renderer.gl;
  const sx = Math.max(0, Math.min(sourceW, Number(zoomViewport.sx || 0)));
  const sy = Math.max(0, Math.min(sourceH, Number(zoomViewport.sy || 0)));
  const sw = Math.max(1, Math.min(sourceW - sx, Number(zoomViewport.sw || sourceW)));
  const sh = Math.max(1, Math.min(sourceH - sy, Number(zoomViewport.sh || sourceH)));

  try {
    gl.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
    gl.useProgram(renderer.program);
    gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceLike);
    gl.uniform4f(
      renderer.srcRectLoc,
      sx / sourceW,
      sy / sourceH,
      sw / sourceW,
      sh / sourceH
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    renderCtx.imageSmoothingEnabled = true;
    renderCtx.imageSmoothingQuality = "high";
    renderCtx.drawImage(renderer.canvas, 0, 0, width, height);
    return true;
  } catch {
    gpuZoomDisabled = true;
    gpuZoomRenderer = null;
    return false;
  }
}

function drawZoomedVideoOn(renderCtx, sourceVideo, zoomViewport, width, height) {
  renderCtx.imageSmoothingEnabled = true;
  renderCtx.imageSmoothingQuality = "high";
  const src = sourceDimensions(sourceVideo, width, height);
  if (!zoomViewport) {
    renderCtx.drawImage(sourceVideo, 0, 0, width, height);
    return;
  }
  const isIdentity = isIdentityViewport(zoomViewport, src.width, src.height);
  if (isIdentity) {
    renderCtx.drawImage(sourceVideo, 0, 0, width, height);
    return;
  }
  const drewViaGpu = drawZoomedVideoGpu(renderCtx, sourceVideo, zoomViewport, width, height);
  if (drewViaGpu) return;
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

  if (!zoomViewport) {
    renderCtx.drawImage(sourceVideo, rect.x, rect.y, rect.width, rect.height);
    return;
  }

  const isIdentity = Math.abs(Number(zoomViewport.sx || 0)) <= 0.001
    && Math.abs(Number(zoomViewport.sy || 0)) <= 0.001
    && Math.abs(Number(zoomViewport.sw || rect.width) - rect.width) <= 0.001
    && Math.abs(Number(zoomViewport.sh || rect.height) - rect.height) <= 0.001;
  if (isIdentity) {
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

function renderExportFrame(
  renderCtx,
  sourceVideo,
  currentMs,
  width,
  height,
  { showHoldInfo = true } = {},
) {
  const sourceW = Math.max(2, Number(sourceVideo?.videoWidth || width || 0));
  const sourceH = Math.max(2, Number(sourceVideo?.videoHeight || height || 0));
  const overlayState = collectFrameOverlayState(currentMs, sourceW, sourceH);
  const pointer = overlayState.pointer;
  const zoomViewport = getZoomViewportAt(currentMs, pointer, sourceW, sourceH);

  // Fast path: skip intermediate compose buffer when no zoom is active.
  const noZoom = zoomViewport.factor <= 1.001
    && Math.abs(zoomViewport.sx) <= 0.001
    && Math.abs(zoomViewport.sy) <= 0.001
    && Math.abs(zoomViewport.sw - sourceW) <= 0.001
    && Math.abs(zoomViewport.sh - sourceH) <= 0.001;

  if (noZoom) {
    renderCtx.clearRect(0, 0, width, height);
    renderCtx.fillStyle = "#000";
    renderCtx.fillRect(0, 0, width, height);
    drawZoomedVideoOn(renderCtx, sourceVideo, null, width, height);
    drawClickBurstsOn(renderCtx, currentMs, sourceW, sourceH, null, {
      hi: overlayState.clickHi,
      lo: overlayState.clickLo,
    });
    drawCursorOn(renderCtx, pointer);
    if (showHoldInfo) {
      drawHeldButtonsFromStateOn(renderCtx, currentMs, overlayState.heldSince);
    }
    drawKeyPillEventOn(renderCtx, overlayState.keyDown, currentMs, width);
    drawTextOverlaysOn(renderCtx, currentMs, width, height);
    return;
  }

  const composed = ensureComposeBuffer(sourceW, sourceH);

  // Pass 1: compose full frame without zoom.
  composed.ctx.clearRect(0, 0, sourceW, sourceH);
  composed.ctx.fillStyle = "#000";
  composed.ctx.fillRect(0, 0, sourceW, sourceH);
  drawZoomedVideoOn(composed.ctx, sourceVideo, null, sourceW, sourceH);
  drawClickBurstsOn(composed.ctx, currentMs, sourceW, sourceH, null, {
    hi: overlayState.clickHi,
    lo: overlayState.clickLo,
  });
  drawCursorOn(composed.ctx, pointer);
  if (showHoldInfo) {
    drawHeldButtonsFromStateOn(composed.ctx, currentMs, overlayState.heldSince);
  }
  drawKeyPillEventOn(composed.ctx, overlayState.keyDown, currentMs, width);

  // Pass 2: apply zoom to whole composed frame (video + overlays together).
  renderCtx.clearRect(0, 0, width, height);
  renderCtx.fillStyle = "#000";
  renderCtx.fillRect(0, 0, width, height);
  drawZoomedVideoOn(renderCtx, composed.canvas, zoomViewport, width, height);

  // Pass 3: draw text overlays on top of zoomed frame so they stay screen-fixed.
  drawTextOverlaysOn(renderCtx, currentMs, width, height);
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

  const hasTimelineEffects = (project.zooms?.length || 0) > 0 || (project.texts?.length || 0) > 0;
  const hasInteractionOverlays = (project.events?.length || 0) > 0;
  if (!hasTimelineEffects && !hasInteractionOverlays) {
    const desktopMp4 = await tryDesktopExportJob();
    if (desktopMp4) {
      downloadBlob(desktopMp4, "guide-recorder-final.mp4");
      setStatus("Final video exported as MP4 via desktop FFmpeg.");
      exportFinalBtn.disabled = false;
      return;
    }
  }

  let exportVideo = null;
  let mezzanineId = "";

  try {
    exportVideo = document.createElement("video");
    let sourceUrl = videoEl.currentSrc || videoEl.src;
    if (isDesktopAutoloadVideoSource()) {
      setStatus("Preparing seek-optimized source for deterministic export...");
      const mezzResp = await fetch("/__desktop/export/mezzanine/start", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({}),
      });
      if (!mezzResp.ok) {
        throw new Error(`Could not build mezzanine source (${mezzResp.status})`);
      }
      const mezzJson = await mezzResp.json();
      mezzanineId = String(mezzJson?.mezzanineId || "");
      sourceUrl = String(mezzJson?.url || "");
      if (!mezzanineId || !sourceUrl) {
        throw new Error("Desktop did not return valid mezzanine source");
      }
    }
    exportVideo.src = sourceUrl;
    exportVideo.playsInline = true;
    exportVideo.preload = "auto";
    exportVideo.volume = 0;

    if (exportVideo.readyState < 1) {
      await waitForMediaEvent(exportVideo, "loadedmetadata");
    }

    const sourceWidth = Math.max(2, exportVideo.videoWidth || 0);
    const sourceHeight = Math.max(2, exportVideo.videoHeight || 0);
    const { width, height } = outputDimensionsForSource(sourceWidth, sourceHeight);
    if (width < 2 || height < 2) {
      throw new Error("Invalid video dimensions for export");
    }
    const exportSourceDurationSec = sourceDurationSecFor(exportVideo.duration);
    const trimRange = trimRangeForDuration(exportSourceDurationSec);
    const trimStartSec = trimRange.startSec;
    const trimEndSec = trimRange.endSec;
    const targetDurationSec = trimRange.durationSec;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext("2d", { willReadFrequently: true });
    const deterministic = await tryDesktopDeterministicFrameExport({
      exportVideo,
      exportCanvas,
      exportCtx,
      width,
      height,
      trimStartSec,
      trimEndSec,
      targetDurationSec,
    });
    if (deterministic?.blob) {
      downloadBlob(deterministic.blob, "guide-recorder-final.mp4");
      setStatus("Final video exported with effects (deterministic MP4).");
      return;
    }
    throw new Error(deterministic?.reason || "Deterministic export did not produce output");
  } catch (err) {
    setStatus(`Export failed: ${err.message || String(err)}`);
  } finally {
    if (exportVideo) {
      try {
        exportVideo.pause();
        exportVideo.removeAttribute("src");
        exportVideo.load();
      } catch {
        // ignore
      }
    }
    if (mezzanineId) {
      fetch("/__desktop/export/mezzanine/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ mezzanineId }),
      }).catch(() => {});
    }
    exportFinalBtn.disabled = false;
  }
}
function renderOverlay() {
  if (!videoEl.src) return;

  fitCanvasToVideo();
  const mediaSec = snapNearZero(videoEl.currentTime);
  const currentMs = Math.max(0, mediaSec * 1000);
  const trimmedSec = mediaToTrimmedSec(mediaSec, videoEl.duration);
  const uiSec = uiCurrentSec(trimmedSec);
  const dur = effectiveDurationSec();
  const cur = dur > 0 ? Math.min(uiSec, dur) : uiSec;
  updateTimelinePlayhead(mediaSec, timelineDurationSec());
  if (!isSeeking) {
    if (dur > 0) seekBar.value = String(Math.round((cur / dur) * 1000));
    else seekBar.value = "0";
  }
  timeLabel.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
  playPauseBtn.textContent = videoEl.paused ? "Play" : "Pause";
  const previewDims = outputDimensionsForSource(videoEl.videoWidth || canvas.width, videoEl.videoHeight || canvas.height);
  const frame = ensurePreviewFrameBuffer(previewDims.width, previewDims.height);

  renderExportFrame(frame.ctx, videoEl, currentMs, frame.width, frame.height, {
    showHoldInfo: false,
  });
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

async function validateVideoBlobDuration(blob, minDurationSec) {
  if (!blob || blob.size <= 0) return false;
  const url = URL.createObjectURL(blob);
  try {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = url;
    await waitForMediaEvent(probe, "loadedmetadata");
    const dur = Number(probe.duration || 0);
    if (!Number.isFinite(dur) || dur <= 0) return false;
    if (minDurationSec > 0 && dur + 0.05 < minDurationSec) return false;
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isDesktopAutoloadVideoSource() {
  const src = String(videoEl.currentSrc || videoEl.src || "");
  return src.includes("/__desktop/latest.video");
}

async function tryDesktopExportJob() {
  if (!isDesktopAutoloadVideoSource()) return null;
  const payload = {
    trimStartSec: Number(project.trimStartSec || 0),
    trimEndSec: Number(project.trimEndSec || 0),
    aspectPreset: normalizeAspectPreset(project.aspectPreset),
    zoomCount: Array.isArray(project.zooms) ? project.zooms.length : 0,
    textCount: Array.isArray(project.texts) ? project.texts.length : 0,
    eventCount: Array.isArray(project.events) ? project.events.length : 0,
  };
  try {
    const resp = await fetch("/__desktop/export/job", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob || blob.size <= 0) return null;
    return new Blob([blob], { type: "video/mp4" });
  } catch {
    return null;
  }
}

async function tryDesktopTranscodeMp4(sourceBlob, fps = 60) {
  if (!sourceBlob || sourceBlob.size <= 0) return null;
  try {
    const resp = await fetch("/__desktop/transcode/mp4", {
      method: "POST",
      headers: {
        "Content-Type": sourceBlob.type || "video/webm",
        "X-Export-Fps": String(Math.max(12, Math.min(120, Math.round(Number(fps) || 60)))),
      },
      body: sourceBlob,
    });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    if (!blob || blob.size <= 0) return null;
    return new Blob([blob], { type: "video/mp4" });
  } catch {
    return null;
  }
}

function canvasToBlob(canvasEl, type, quality) {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas encoding failed"));
    }, type, quality);
  });
}

function formatPerfMs(ms, divisor = 1) {
  const safeDiv = Math.max(1, Number(divisor || 1));
  return (Number(ms || 0) / safeDiv).toFixed(1);
}

async function seekVideoForFrame(video, sec) {
  const target = Math.max(0, Number(sec || 0));
  if (Math.abs(Number(video.currentTime || 0) - target) < 0.0005) return;
  video.currentTime = target;
  await waitForMediaEvent(video, "seeked");
}

function disposeVideoElement(video) {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    // ignore
  }
}

async function tryDesktopDeterministicFrameExport({
  exportVideo,
  exportCanvas,
  exportCtx,
  width,
  height,
  trimStartSec,
  trimEndSec,
  targetDurationSec,
}) {
  if (!(targetDurationSec > 0)) return { blob: null, reason: "target duration is 0s" };
  const fpsMode = normalizeRenderFpsMode(project.renderFpsMode);
  const frameFormat = normalizeRenderFrameTransport(project.renderFrameTransport);
  const fps = fpsMode === "custom"
    ? normalizeRenderFpsValue(project.renderFpsValue)
    : await preferredDeterministicFps(exportVideo);
  const frameMimeType = frameFormat === "jpeg" ? "image/jpeg" : "image/png";
  const frameEncodeQuality = frameFormat === "jpeg" ? 0.95 : undefined;
  const totalFrames = Math.max(1, Math.round(targetDurationSec * fps));
  if (totalFrames > DETERMINISTIC_EXPORT_MAX_FRAMES) {
    return {
      blob: null,
      reason: `too long (${totalFrames} frames > ${DETERMINISTIC_EXPORT_MAX_FRAMES})`,
    };
  }

  let jobId = "";
  let chunkVideo = null;
  try {
    const sourceUrl = String(exportVideo.currentSrc || exportVideo.src || "");
    if (!sourceUrl) {
      return { blob: null, reason: "export video source is empty" };
    }
    const perf = {
      totalStartMs: performance.now(),
      seekMs: 0,
      renderMs: 0,
      encodeMs: 0,
      uploadWaitMs: 0,
      uploadHttpMs: 0,
      uploadCount: 0,
      startReqMs: 0,
      finalizeReqMs: 0,
    };
    setStatus(`Starting deterministic export (${fps.toFixed(3)}fps, ${frameFormat.toUpperCase()})...`);
    console.log(
      "[export-config]",
      `fps=${fps.toFixed(6)}`,
      `transport=${frameFormat}`,
      `trim_start=${trimStartSec.toFixed(6)}`,
      `trim_end=${trimEndSec.toFixed(6)}`,
      `duration=${targetDurationSec.toFixed(6)}`,
      `total_frames=${totalFrames}`
    );
    const startReqStart = performance.now();
    const startResp = await fetch("/__desktop/export/frames/start", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        fps,
        width,
        height,
        trimStartSec,
        trimEndSec,
        includeDesktopAudio: isDesktopAutoloadVideoSource(),
        frameFormat,
      }),
    });
    if (!startResp.ok) return { blob: null, reason: `start endpoint failed (${startResp.status})` };
    const startJson = await startResp.json();
    perf.startReqMs = Math.max(0, performance.now() - startReqStart);
    jobId = String(startJson?.jobId || "");
    if (!jobId) return { blob: null, reason: "desktop did not return jobId" };

    exportVideo.pause();

    const uploadFrame = async (framePayload, thisIndex) => {
      const uploadStart = performance.now();
      const resp = await fetch(`/__desktop/export/frames/frame?jobId=${encodeURIComponent(jobId)}&index=${thisIndex}`, {
        method: "POST",
        headers: { "Content-Type": frameMimeType },
        body: framePayload,
      });
      if (!resp.ok) throw new Error(`frame upload failed at ${thisIndex} (${resp.status})`);
      perf.uploadHttpMs += Math.max(0, performance.now() - uploadStart);
      perf.uploadCount += 1;
    };
    const MAX_IN_FLIGHT = 2;
    const inFlightUploads = new Set();
    let uploadError = null;
    const waitForFreeUploadSlot = async () => {
      while (inFlightUploads.size >= MAX_IN_FLIGHT) {
        const waitStart = performance.now();
        await Promise.race(inFlightUploads);
        perf.uploadWaitMs += Math.max(0, performance.now() - waitStart);
      }
      if (uploadError) throw uploadError;
    };

    const createChunkVideoAt = async (sec) => {
      const v = document.createElement("video");
      v.src = sourceUrl;
      v.playsInline = true;
      v.preload = "auto";
      v.volume = 0;
      if (v.readyState < 1) {
        await waitForMediaEvent(v, "loadedmetadata");
      }
      await seekVideoForFrame(v, sec);
      return v;
    };

    setStatus(`Deterministic export started. Rendering frames 0/${totalFrames}...`);
    const CHUNK_FRAMES = 120;
    let currentVideo = exportVideo;
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const targetSec = trimStartSec + (frameIndex / fps);
      if (frameIndex > 0 && frameIndex % CHUNK_FRAMES === 0) {
        const rebuildStart = performance.now();
        const nextVideo = await createChunkVideoAt(targetSec);
        if (currentVideo !== exportVideo) {
          disposeVideoElement(currentVideo);
        }
        currentVideo = nextVideo;
        chunkVideo = nextVideo;
        perf.seekMs += Math.max(0, performance.now() - rebuildStart);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      const seekStart = performance.now();
      await seekVideoForFrame(currentVideo, targetSec);
      perf.seekMs += Math.max(0, performance.now() - seekStart);

      const renderMs = targetSec * 1000;
      const drawStart = performance.now();
      renderExportFrame(exportCtx, currentVideo, renderMs, width, height);
      perf.renderMs += Math.max(0, performance.now() - drawStart);
      const encodeStart = performance.now();
      const encodedFrame = await canvasToBlob(exportCanvas, frameMimeType, frameEncodeQuality);
      perf.encodeMs += Math.max(0, performance.now() - encodeStart);
      await waitForFreeUploadSlot();
      const trackedUpload = uploadFrame(encodedFrame, frameIndex).catch((err) => {
        uploadError = err;
        throw err;
      }).finally(() => {
        inFlightUploads.delete(trackedUpload);
      });
      inFlightUploads.add(trackedUpload);

      const done = frameIndex + 1;
      if (done === 1 || done % 15 === 0 || done >= totalFrames) {
        const elapsedMs = Math.max(1, performance.now() - perf.totalStartMs);
        const effFps = (done * 1000) / elapsedMs;
        const seekPer = formatPerfMs(perf.seekMs, done);
        const renderPer = formatPerfMs(perf.renderMs, done);
        const encodePer = formatPerfMs(perf.encodeMs, done);
        setStatus(
          `Deterministic export: ${done}/${totalFrames} (${effFps.toFixed(1)}fps) `
          + `seek=${seekPer}ms render=${renderPer}ms encode=${encodePer}ms`
        );
        console.log(
          "[export-perf-live]",
          `frame=${done}/${totalFrames}`,
          `fps=${effFps.toFixed(1)}`,
          `seek_ms_per_frame=${seekPer}`,
          `render_ms_per_frame=${renderPer}`,
          `encode_ms_per_frame=${encodePer}`,
          `upload_wait_ms=${formatPerfMs(perf.uploadWaitMs)}`
        );
      }
      // Yield every frame so GC can reclaim readback buffers under high pressure.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    if (inFlightUploads.size > 0) {
      const waitStart = performance.now();
      await Promise.all(Array.from(inFlightUploads));
      perf.uploadWaitMs += Math.max(0, performance.now() - waitStart);
    }
    if (uploadError) throw uploadError;
    if (currentVideo !== exportVideo) {
      disposeVideoElement(currentVideo);
      chunkVideo = null;
    } else {
      exportVideo.pause();
    }

    const finalizeStart = performance.now();
    const finalizeResp = await fetch("/__desktop/export/frames/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        jobId,
        fps,
        trimStartSec,
        trimEndSec,
      }),
    });
    perf.finalizeReqMs = Math.max(0, performance.now() - finalizeStart);
    if (!finalizeResp.ok) return { blob: null, reason: `finalize failed (${finalizeResp.status})` };
    const outBlob = await finalizeResp.blob();
    if (!outBlob || outBlob.size <= 0) return { blob: null, reason: "finalize returned empty file" };
    const outMp4 = new Blob([outBlob], { type: "video/mp4" });
    const ok = await validateVideoBlobDuration(outMp4, targetDurationSec * 0.9);
    if (!ok) return { blob: null, reason: "final MP4 failed duration validation" };
    const totalMs = Math.max(1, performance.now() - perf.totalStartMs);
    const summary = [
      `deterministic perf (${totalFrames}f @ ${fps}fps target):`,
      `total=${formatPerfMs(totalMs)}ms (${((totalFrames * 1000) / totalMs).toFixed(1)}fps)`,
      `seek=${formatPerfMs(perf.seekMs)}ms (${formatPerfMs(perf.seekMs, totalFrames)}/f)`,
      `render=${formatPerfMs(perf.renderMs)}ms (${formatPerfMs(perf.renderMs, totalFrames)}/f)`,
      `encode=${formatPerfMs(perf.encodeMs)}ms (${formatPerfMs(perf.encodeMs, totalFrames)}/f)`,
      `upload_wait=${formatPerfMs(perf.uploadWaitMs)}ms`,
      `upload_http=${formatPerfMs(perf.uploadHttpMs)}ms for ${perf.uploadCount} frames`,
      `start_req=${formatPerfMs(perf.startReqMs)}ms finalize_req=${formatPerfMs(perf.finalizeReqMs)}ms`,
    ].join(" ");
    console.log("[export-perf]", summary);
    setStatus(`Deterministic export done. ${((totalFrames * 1000) / totalMs).toFixed(1)}fps (see console [export-perf]).`);
    return { blob: outMp4, reason: "" };
  } catch (err) {
    return { blob: null, reason: err?.message || "exception in deterministic export" };
  } finally {
    if (chunkVideo) {
      disposeVideoElement(chunkVideo);
      chunkVideo = null;
    }
    if (jobId) {
      fetch("/__desktop/export/frames/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    }
  }
}

async function preferredDeterministicFps(video) {
  if (isDesktopAutoloadVideoSource()) {
    const resp = await fetch("/__desktop/source/fps", { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`Could not probe source FPS (${resp.status})`);
    }
    const json = await resp.json();
    const probed = Number(json?.fps || 0);
    if (probed > 0 && Number.isFinite(probed)) {
      return Math.max(1, Math.min(240, probed));
    }
    throw new Error("Desktop source FPS probe returned invalid value");
  }
  try {
    const stream = video.captureStream();
    const [track] = stream.getVideoTracks();
    const settings = track?.getSettings ? track.getSettings() : null;
    const raw = Number(settings?.frameRate || 0);
    stream.getTracks().forEach((t) => t.stop());
    if (raw > 45) return 60;
    if (raw > 0) return 30;
  } catch {
    // ignore
  }
  return 30;
}

function saveProjectJson() {
  const serializable = serializeProjectState();

  const blob = new Blob([JSON.stringify(serializable, null, 2)], { type: "application/json" });
  downloadBlob(blob, "guide-recorder-project.json");
}

async function applyLoadedProjectData(data) {
  project.events = Array.isArray(data.events) ? data.events : [];
  project.events.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
  project.zooms = Array.isArray(data.zooms) ? data.zooms : [];
  project.texts = Array.isArray(data.texts) ? data.texts : [];
  project.texts = project.texts.map((t) => ({
    ...t,
    fontFamily: selectedTextFontFamily(t?.fontFamily),
    fontWeight: String(t?.fontWeight || "normal") === "bold" ? "bold" : "normal",
    fontStyle: String(t?.fontStyle || "normal") === "italic" ? "italic" : "normal",
    transition: normalizedTextTransition(t?.transition),
    smoothMs: Math.max(0, Math.min(5000, Number(t?.smoothMs || 0))),
  }));
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
  project.cursorMotionMode = normalizeCursorMotionMode(data.cursorMotionMode);
  project.cursorSplineGuideHz = data.cursorSplineGuideHz != null
    ? normalizeCursorSplineGuideHz(data.cursorSplineGuideHz)
    : legacySmoothStrengthToGuideHz(data.cursorSmoothStrength);
  project.aspectPreset = normalizeAspectPreset(data.aspectPreset);
  project.trimStartSec = Number(data.trimStartSec || 0);
  project.trimEndSec = Number(data.trimEndSec || 0);
  project.renderFrameTransport = normalizeRenderFrameTransport(data.renderFrameTransport);
  project.renderFpsMode = normalizeRenderFpsMode(data.renderFpsMode);
  project.renderFpsValue = normalizeRenderFpsValue(data.renderFpsValue);
  project.cursorTextureName = String(data.cursorTextureName || "");
  cursorOffsetXInput.value = String(project.cursorOffsetX);
  cursorOffsetYInput.value = String(project.cursorOffsetY);
  if (cursorSplineGuideHzInput) {
    cursorSplineGuideHzInput.value = String(project.cursorSplineGuideHz);
  }
  syncCursorMotionModeUi();
  syncAspectPresetUi();
  syncRenderSettingsUi();
  syncCursorHotspotInputs();
  await loadCursorTextureFromDataUrl(
    String(data.cursorTextureDataUrl || ""),
    project.cursorTextureName,
    false
  );
  sortEffects();
  normalizeTrimBoundsForDuration(sourceDurationSecFor(videoEl.duration));
  renderEffectsTimeline();
  syncPreviewStageAspect();
  fitCanvasToVideo();
  if (videoEl.src) {
    if (videoEl.paused) renderOverlay();
    else startRenderLoop();
  }
  queueDraftProjectPersist();
}

function openDraftDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = window.indexedDB.open(EDITOR_DRAFT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EDITOR_DRAFT_STORE)) {
        db.createObjectStore(EDITOR_DRAFT_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed opening draft database"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function putDraftValue(key, value) {
  const db = await openDraftDb();
  try {
    const tx = db.transaction(EDITOR_DRAFT_STORE, "readwrite");
    tx.objectStore(EDITOR_DRAFT_STORE).put({ key, value, savedAt: Date.now() });
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function getDraftValue(key) {
  const db = await openDraftDb();
  try {
    const tx = db.transaction(EDITOR_DRAFT_STORE, "readonly");
    const req = tx.objectStore(EDITOR_DRAFT_STORE).get(key);
    const row = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("Failed reading draft value"));
    });
    await txDone(tx);
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function serializeProjectState() {
  return {
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
    cursorMotionMode: normalizeCursorMotionMode(project.cursorMotionMode),
    cursorSplineGuideHz: normalizeCursorSplineGuideHz(project.cursorSplineGuideHz),
    aspectPreset: normalizeAspectPreset(project.aspectPreset),
    trimStartSec: Number(project.trimStartSec || 0),
    trimEndSec: Number(project.trimEndSec || 0),
    renderFrameTransport: normalizeRenderFrameTransport(project.renderFrameTransport),
    renderFpsMode: normalizeRenderFpsMode(project.renderFpsMode),
    renderFpsValue: normalizeRenderFpsValue(project.renderFpsValue),
  };
}

function queueDraftProjectPersist() {
  window.clearTimeout(draftPersistTimer);
  draftPersistTimer = window.setTimeout(async () => {
    try {
      await putDraftValue(EDITOR_DRAFT_PROJECT_KEY, serializeProjectState());
    } catch {
      // Ignore draft persistence failures.
    }
  }, 260);
}

async function persistDraftVideoSource(source) {
  try {
    await putDraftValue(EDITOR_DRAFT_VIDEO_KEY, source);
  } catch {
    // Ignore draft persistence failures.
  }
}

function attachCurrentVideoToPlayer(statusText = "") {
  videoEl.src = importedVideoUrl || "";
  videoEl.onloadedmetadata = () => {
    const range = normalizeTrimBoundsForDuration(sourceDurationSecFor(videoEl.duration));
    if (range.startSec > 0) {
      try {
        videoEl.currentTime = range.startSec;
      } catch {
        // ignore
      }
    }
    updateSourceAspectOptionLabel(videoEl.videoWidth, videoEl.videoHeight);
    syncPreviewStageAspect();
    fitCanvasToVideo();
    clampPlaybackToEffectiveDuration();
    startRenderLoop();
    refreshActionButtons();
    renderEffectsTimeline();
    syncPlaybackUi();
  };
  refreshActionButtons();
  if (statusText) setStatus(statusText);
}

async function restoreDraftSession() {
  let projectDraft = null;
  let videoDraft = null;
  try {
    [projectDraft, videoDraft] = await Promise.all([
      getDraftValue(EDITOR_DRAFT_PROJECT_KEY),
      getDraftValue(EDITOR_DRAFT_VIDEO_KEY),
    ]);
  } catch {
    return false;
  }

  if (!projectDraft && !videoDraft) return false;

  if (projectDraft) {
    try {
      await applyLoadedProjectData(projectDraft);
    } catch {
      // Ignore malformed draft project and still try restoring video.
    }
  }

  if (videoDraft && typeof videoDraft === "object") {
    if (importedVideoUrl && importedVideoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(importedVideoUrl);
    }
    if (videoDraft.kind === "blob" && videoDraft.blob instanceof Blob) {
      importedVideoUrl = URL.createObjectURL(videoDraft.blob);
      attachCurrentVideoToPlayer("Restored previous editor session.");
    } else if (videoDraft.kind === "url" && typeof videoDraft.url === "string" && videoDraft.url) {
      const cacheBust = videoDraft.url.includes("?") ? "&" : "?";
      importedVideoUrl = `${videoDraft.url}${cacheBust}t=${Date.now()}`;
      attachCurrentVideoToPlayer("Restored previous editor session.");
    }
  }

  if (projectDraft) saveProjectBtn.disabled = false;
  return Boolean(projectDraft || videoEl.src);
}

async function loadProjectJson(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  await applyLoadedProjectData(data);
  saveProjectBtn.disabled = false;
  setStatus("Project JSON loaded. Attach a video to preview effects.");
}

async function tryDesktopAutoLoad() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("autoloaddesktop") !== "1") return false;

  try {
    const jsonResp = await fetch("/__desktop/latest.json", { cache: "no-store" });
    if (!jsonResp.ok) {
      setStatus("Desktop autoload failed. Load video/json manually.");
      return false;
    }

    const data = await jsonResp.json();

    await applyLoadedProjectData(data);
    // Desktop autoload should always start with full active range.
    project.trimStartSec = 0;
    project.trimEndSec = 0;

    if (importedVideoUrl && importedVideoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(importedVideoUrl);
    }
    importedVideoUrl = `/__desktop/latest.video?t=${Date.now()}`;
    attachCurrentVideoToPlayer();
    saveProjectBtn.disabled = false;
    await persistDraftVideoSource({ kind: "url", url: "/__desktop/latest.video" });
    queueDraftProjectPersist();
    refreshActionButtons();
    setStatus("Desktop recording auto-loaded. Start editing.");
    return true;
  } catch {
    setStatus("Desktop autoload failed. Load video/json manually.");
    return false;
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
  // A newly loaded standalone video should start untrimmed.
  project.trimStartSec = 0;
  project.trimEndSec = 0;
  if (importedVideoUrl && importedVideoUrl.startsWith("blob:")) {
    URL.revokeObjectURL(importedVideoUrl);
  }
  importedVideoUrl = URL.createObjectURL(file);
  attachCurrentVideoToPlayer();
  await persistDraftVideoSource({
    kind: "blob",
    name: file.name || "",
    mimeType: file.type || "",
    blob: file,
  });
  queueDraftProjectPersist();
  setStatus(`Loaded video file: ${file.name}`);
});

if (aspectPresetSelect) {
  aspectPresetSelect.addEventListener("change", () => {
    project.aspectPreset = normalizeAspectPreset(aspectPresetSelect.value);
    syncAspectPresetUi();
    syncPreviewStageAspect();
    fitCanvasToVideo();
    if (videoEl.src) {
      if (videoEl.paused) renderOverlay();
      else startRenderLoop();
    }
    queueDraftProjectPersist();
  });
}
if (renderTransportSelect) {
  renderTransportSelect.addEventListener("change", () => {
    project.renderFrameTransport = normalizeRenderFrameTransport(renderTransportSelect.value);
    syncRenderSettingsUi();
    queueDraftProjectPersist();
  });
}
if (renderFpsModeSelect) {
  renderFpsModeSelect.addEventListener("change", () => {
    project.renderFpsMode = normalizeRenderFpsMode(renderFpsModeSelect.value);
    syncRenderSettingsUi();
    queueDraftProjectPersist();
  });
}
if (renderFpsValueInput) {
  renderFpsValueInput.addEventListener("input", () => {
    project.renderFpsValue = normalizeRenderFpsValue(renderFpsValueInput.value);
    syncRenderSettingsUi();
    queueDraftProjectPersist();
  });
}

exportFinalBtn.addEventListener("click", exportFinalVideo);
cursorOffsetXInput.addEventListener("input", () => {
  project.cursorOffsetX = Number(cursorOffsetXInput.value || 0);
  persistCursorPrefsToLocalStorage();
  queueDraftProjectPersist();
});
cursorOffsetYInput.addEventListener("input", () => {
  project.cursorOffsetY = Number(cursorOffsetYInput.value || 0);
  persistCursorPrefsToLocalStorage();
  queueDraftProjectPersist();
});
if (cursorMotionModeSelect) {
  cursorMotionModeSelect.addEventListener("change", () => {
    project.cursorMotionMode = normalizeCursorMotionMode(cursorMotionModeSelect.value);
    syncCursorMotionModeUi();
    persistCursorPrefsToLocalStorage();
    queueDraftProjectPersist();
  });
}
if (cursorSplineGuideHzInput) {
  cursorSplineGuideHzInput.addEventListener("input", () => {
    project.cursorSplineGuideHz = normalizeCursorSplineGuideHz(cursorSplineGuideHzInput.value);
    cursorSplineGuideHzInput.value = String(project.cursorSplineGuideHz);
    persistCursorPrefsToLocalStorage();
    queueDraftProjectPersist();
  });
}
cursorHotspotXInput.addEventListener("input", () => {
  project.cursorHotspotX = Number(cursorHotspotXInput.value || 0);
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
  queueDraftProjectPersist();
});
cursorHotspotYInput.addEventListener("input", () => {
  project.cursorHotspotY = Number(cursorHotspotYInput.value || 0);
  clampHotspotToImageBounds();
  syncCursorHotspotInputs();
  renderCursorPreviewCanvas();
  persistCursorPrefsToLocalStorage();
  queueDraftProjectPersist();
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
  queueDraftProjectPersist();
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
  normalizeTrimBoundsForDuration(sourceDurationSecFor(videoEl.duration));
  clampPlaybackToEffectiveDuration();
  updateSourceAspectOptionLabel(videoEl.videoWidth, videoEl.videoHeight);
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
  videoEl.currentTime = trimmedToMediaSec(dur * p, videoEl.duration);
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

function isPointerOverSegment(trackEl, clientX) {
  const segments = trackEl.querySelectorAll(".timeline-segment");
  for (const seg of segments) {
    const rect = seg.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right) return true;
  }
  return false;
}

function onLanePointerMove(kind, e) {
  if (resizingEffect) {
    setLaneAddBlocked(kind, true);
    return;
  }
  const trackEl = kind === "zoom" ? zoomTrack : textTrack;
  const overSegment = isPointerOverSegment(trackEl, e.clientX);
  setLaneAddBlocked(kind, overSegment);
  if (overSegment) return;
  setLaneAddButtonPosition(kind, e.clientX);
}

function addEffectAt(kind, atSec) {
  const startSec = Math.max(0, Number(atSec || 0));
  const maxDur = timelineDurationSec();
  const endSec = Math.min(maxDur, startSec + 2);
  if (kind === "zoom") {
    const z = {
      startSec,
      endSec,
      scale: 1.8,
      easeMs: 180,
    };
    project.zooms.push(z);
    sortEffects();
    renderEffectsTimeline();
    queueDraftProjectPersist();
    return;
  }
  const t = {
    startSec,
    endSec,
    xPct: 12,
    yPct: 12,
    align: "left",
    value: "Text",
    fontSize: 22,
    fontFamily: "Segoe UI",
    fontWeight: "normal",
    fontStyle: "normal",
    transition: "none",
    smoothMs: 0,
    color: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 68,
  };
  project.texts.push(t);
  sortEffects();
  renderEffectsTimeline();
  queueDraftProjectPersist();
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
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
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
  const segEl = e.target.closest(".timeline-segment");
  if (segEl) {
    if (suppressNextSegmentClick) {
      suppressNextSegmentClick = false;
      return;
    }
    const kind = segEl.dataset.kind;
    if (kind === "trim") return;
    const index = Number(segEl.dataset.index || -1);
    if ((kind === "zoom" || kind === "text") && index >= 0) {
      openEffectEditor(kind, index, segEl, { clientX: e.clientX, clientY: e.clientY });
    }
    return;
  }
  // If click landed on a track area, add an effect instead of seeking.
  const trackEl = e.target.closest(".timeline-track");
  if (trackEl) {
    const kind = trackEl === zoomTrack ? "zoom" : trackEl === textTrack ? "text" : null;
    if (kind) {
      const atSec = timeFromTrackPointer(trackEl, e.clientX);
      addEffectAt(kind, atSec);
      return;
    }
  }

  if (!videoEl.src) return;
  uiPrimedForPlayback = true;
  const dur = timelineDurationSec();
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
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
  if (e.target.closest(".timeline-remove-btn")) return;
  const segEl = e.target.closest(".timeline-segment");
  if (!segEl) return;
  const handleEl = e.target.closest(".timeline-handle");
  const kind = segEl.dataset.kind;
  if (kind === "trim") {
    const side = (handleEl && (handleEl.dataset.side === "left" || handleEl.dataset.side === "right"))
      ? handleEl.dataset.side
      : resizeSideFromPoint(segEl, e.clientX);
    const durSec = Math.max(0, sourceDurationSecFor(videoEl.duration), timelineDurationSec());
    const range = trimRangeForDuration(durSec);
    const mode = (side === "left" || side === "right") ? side : "move";
    suppressNextSegmentClick = true;
    resizingEffect = {
      kind: "trim",
      side: mode,
      trackEl: trimTrack,
      startClientX: e.clientX,
      origTrimStart: range.startSec,
      origTrimEnd: range.endSec,
      durSec,
      moved: false,
    };
    timelineSurface.classList.add("dragging");
    return;
  }
  const index = Number(segEl.dataset.index || -1);
  const side = (handleEl && (handleEl.dataset.side === "left" || handleEl.dataset.side === "right"))
    ? handleEl.dataset.side
    : resizeSideFromPoint(segEl, e.clientX);
  const list = effectsFor(kind);
  const effect = list[index];
  const trackEl = kind === "zoom" ? zoomTrack : textTrack;
  if (!effect || !trackEl) return;
  const mode = (side === "left" || side === "right") ? side : "move";
  suppressNextSegmentClick = true;
  resizingEffect = {
    kind,
    effect,
    side: mode,
    trackEl,
    startClientX: e.clientX,
    origStart: Number(effect.startSec || 0),
    origEnd: Number(effect.endSec || 0),
    durSec: timelineDurationSec(),
    moved: false,
  };
  timelineSurface.classList.add("dragging");
});

window.addEventListener("pointermove", (e) => {
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
  if (!resizingEffect) return;
  const { kind, effect, side, trackEl, startClientX, origStart, origEnd, durSec } = resizingEffect;
  if (kind === "trim") {
    const dx = e.clientX - startClientX;
    const deltaSec = (dx / Math.max(1, trackEl.getBoundingClientRect().width)) * durSec;
    if (Math.abs(dx) > 2) resizingEffect.moved = true;
    const originalStart = Number(resizingEffect.origTrimStart || 0);
    const originalEnd = Number(resizingEffect.origTrimEnd || 0);
    const currentSpan = Math.max(MIN_TRIM_DURATION_SEC, originalEnd - originalStart);
    if (side === "left") {
      project.trimStartSec = Math.max(0, Math.min(originalEnd - MIN_TRIM_DURATION_SEC, originalStart + deltaSec));
      project.trimEndSec = originalEnd;
      document.body.style.cursor = "ew-resize";
    } else if (side === "right") {
      project.trimStartSec = originalStart;
      project.trimEndSec = Math.max(originalStart + MIN_TRIM_DURATION_SEC, Math.min(durSec, originalEnd + deltaSec));
      document.body.style.cursor = "ew-resize";
    } else {
      let nextStart = originalStart + deltaSec;
      nextStart = Math.max(0, Math.min(durSec - currentSpan, nextStart));
      project.trimStartSec = nextStart;
      project.trimEndSec = nextStart + currentSpan;
      document.body.style.cursor = "grabbing";
    }
    normalizeTrimBoundsForDuration(durSec);
    clampPlaybackToEffectiveDuration();
    renderEffectsTimeline();
    syncPlaybackUi();
    return;
  }
  if (!effect) return;
  const dx = e.clientX - startClientX;
  const deltaSec = (dx / Math.max(1, trackEl.getBoundingClientRect().width)) * durSec;
  if (Math.abs(dx) > 2) resizingEffect.moved = true;
  if (side === "move") {
    const duration = origEnd - origStart;
    let newStart = origStart + deltaSec;
    newStart = Math.max(0, Math.min(durSec - duration, newStart));
    effect.startSec = newStart;
    effect.endSec = newStart + duration;
    document.body.style.cursor = "grabbing";
  } else if (side === "left") {
    effect.startSec = Math.max(0, Math.min(origEnd - MIN_EFFECT_DURATION_SEC, origStart + deltaSec));
    document.body.style.cursor = "ew-resize";
  } else {
    effect.endSec = Math.max(origStart + MIN_EFFECT_DURATION_SEC, origEnd + deltaSec);
    document.body.style.cursor = "ew-resize";
  }
  clampEffectBounds(effect);
  sortEffects();
  renderEffectsTimeline();
  syncPlaybackUi();
});

window.addEventListener("pointerup", () => {
  if (resizingEffect) {
    suppressNextSegmentClick = resizingEffect.moved;
    queueDraftProjectPersist();
  }
  resizingEffect = null;
  document.body.style.cursor = "";
  timelineSurface.classList.remove("dragging");
});

timelineSurface.addEventListener("pointermove", (e) => {
  lastPointerClientX = e.clientX;
  lastPointerClientY = e.clientY;
  if (resizingEffect) {
    timelineSurface.style.cursor = resizingEffect.side === "move" ? "grabbing" : "ew-resize";
    return;
  }
  const segEl = e.target.closest(".timeline-segment");
  if (segEl && (segEl.dataset.kind === "zoom" || segEl.dataset.kind === "text")) {
    lastHoveredSegmentRef = {
      kind: segEl.dataset.kind,
      index: Number(segEl.dataset.index || -1),
    };
  }
  if (!segEl) {
    timelineSurface.style.cursor = "pointer";
    return;
  }
  const side = resizeSideFromPoint(segEl, e.clientX);
  timelineSurface.style.cursor = side ? "ew-resize" : "grab";
});

timelineSurface.addEventListener("pointerleave", () => {
  if (!resizingEffect) timelineSurface.style.cursor = "pointer";
  lastHoveredSegmentRef = null;
});

effectEditorCloseBtn.addEventListener("click", () => {
  hideEffectEditor();
});

effectEditorDeleteBtn.addEventListener("click", () => {
  deleteSelectedEffect();
});

effectEditorDuplicateBtn.addEventListener("click", () => {
  if (!editingEffect) return;
  const { kind, effect } = editingEffect;
  const clone = JSON.parse(JSON.stringify(effect));
  const shiftSec = 0.5;
  clone.startSec = Number(clone.startSec || 0) + shiftSec;
  clone.endSec = Number(clone.endSec || 0) + shiftSec;
  const list = effectsFor(kind);
  list.push(clone);
  sortEffects();
  const newIndex = list.indexOf(clone);
  hideEffectEditor();
  openEffectEditor(kind, newIndex);
  queueDraftProjectPersist();
});

if (cursorSettingsBtn) {
  cursorSettingsBtn.addEventListener("click", () => {
    const shouldShow = cursorPopover?.classList.contains("hidden");
    if (shouldShow) toggleRenderSettingsPopover(false);
    toggleCursorPopover(Boolean(shouldShow));
  });
}
if (cursorPopoverCloseBtn) {
  cursorPopoverCloseBtn.addEventListener("click", () => {
    toggleCursorPopover(false);
  });
}
if (renderSettingsBtn) {
  renderSettingsBtn.addEventListener("click", () => {
    const shouldShow = renderSettingsPopover?.classList.contains("hidden");
    if (shouldShow) toggleCursorPopover(false);
    toggleRenderSettingsPopover(Boolean(shouldShow));
  });
}
if (renderSettingsCloseBtn) {
  renderSettingsCloseBtn.addEventListener("click", () => {
    toggleRenderSettingsPopover(false);
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
  if (renderSettingsPopover && !renderSettingsPopover.classList.contains("hidden")) {
    if (!renderSettingsPopover.contains(target) && !renderSettingsBtn?.contains(target)) {
      toggleRenderSettingsPopover(false);
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
  const target = e.target;
  const isEditable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  const cmdOrCtrl = e.ctrlKey || e.metaKey;
  if (cmdOrCtrl && !e.shiftKey && !e.altKey && !isEditable && (e.key === "c" || e.key === "C")) {
    if (copySelectedEffectToClipboard()) e.preventDefault();
    return;
  }
  if (cmdOrCtrl && !e.shiftKey && !e.altKey && !isEditable && (e.key === "v" || e.key === "V")) {
    if (pasteEffectFromClipboardAtPointer()) e.preventDefault();
    return;
  }
  if (e.key !== "Delete") return;
  if (isEditable) return;
  if (deleteSelectedEffect()) {
    e.preventDefault();
  }
});

setStatus("Idle. Load recording JSON/video to begin editing.");
installLocalPatrickFontAlias();
if (DEBUG_TEXT_FONT) {
  console.log("[text-font-debug] startup font checks", {
    patrickHand: document.fonts?.check?.("16px 'Patrick Hand'") ?? null,
    patrickHandRegular: document.fonts?.check?.("16px 'PatrickHand-Regular'") ?? null,
    segoeUI: document.fonts?.check?.("16px 'Segoe UI'") ?? null,
  });
}
refreshActionButtons();
syncAspectPresetUi();
syncRenderSettingsUi();
syncCursorMotionModeUi();
updateSourceAspectOptionLabel(0, 0);
syncPlaybackUi();
renderCursorPreviewCanvas();
renderEffectsTimeline();
requestAnimationFrame(syncPreviewStageAspect);

(async () => {
  const params = new URLSearchParams(window.location.search);
  const wantsDesktopAutoload = params.get("autoloaddesktop") === "1";
  if (wantsDesktopAutoload) {
    const loadedDesktop = await tryDesktopAutoLoad();
    if (!loadedDesktop) {
      await restoreDraftSession();
    }
  } else {
    await restoreDraftSession();
  }
  await loadCursorPrefsFromLocalStorage();
})();





