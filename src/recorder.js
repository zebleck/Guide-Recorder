const sourceSelect = document.getElementById("sourceSelect");
const selectAreaBtn = document.getElementById("selectAreaBtn");
const startBtn = document.getElementById("startBtn");
const closeBtn = document.getElementById("closeBtn");
const dockEl = document.querySelector(".dock");

let isRecording = false;
let selectedArea = null;
let useSelectedArea = false;
let fittedOnce = false;

function setSelectAreaButtonState(enabled) {
  selectAreaBtn.classList.toggle("area-on", Boolean(enabled));
  const label = enabled ? "Disable selected area" : "Select and enable area";
  selectAreaBtn.title = label;
  selectAreaBtn.setAttribute("aria-label", label);
}

function fitDockWindow() {
  if (fittedOnce) return;
  const rect = dockEl?.getBoundingClientRect();
  const bodyStyle = window.getComputedStyle(document.body);
  const padTop = Number.parseFloat(bodyStyle.paddingTop || "0") || 0;
  const padRight = Number.parseFloat(bodyStyle.paddingRight || "0") || 0;
  const padBottom = Number.parseFloat(bodyStyle.paddingBottom || "0") || 0;
  const padLeft = Number.parseFloat(bodyStyle.paddingLeft || "0") || 0;
  const contentHeight = Math.ceil((rect?.height || 0) + padTop + padBottom);
  const contentWidth = Math.ceil((rect?.width || 0) + padLeft + padRight);
  window.recorderApi.fitWindow({
    height: Math.ceil(contentHeight),
    width: Math.ceil(contentWidth),
  }).then(() => {
    fittedOnce = true;
  }).catch(() => {});
}

function syncAreaPreview() {
  return window.recorderApi.setAreaPreview({
    enabled: Boolean(useSelectedArea && selectedArea),
    recording: Boolean(isRecording),
    bounds: useSelectedArea && selectedArea ? selectedArea : null,
  }).catch(() => {});
}

function shortDiag(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const lines = s.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n");
}

function applyStoppedUiState() {
  isRecording = false;
  startBtn.disabled = false;
}

function handleStopResult(result) {
  applyStoppedUiState();
  syncAreaPreview();
  if (!result?.ok) {
    const diag = shortDiag(result?.ffmpegDiagnostics);
    console.warn("Stop failed:", result?.reason || "Unknown error", diag);
  }
}

async function loadSources() {
  const sources = await window.recorderApi.listSources();
  sourceSelect.innerHTML = "";

  for (const source of sources) {
    const opt = document.createElement("option");
    opt.value = source.id;
    opt.textContent = source.name;
    opt.dataset.name = source.name;
    sourceSelect.appendChild(opt);
  }
  setTimeout(() => {
    fittedOnce = false;
    fitDockWindow();
  }, 0);
}

function selectedSource() {
  const opt = sourceSelect.selectedOptions?.[0];
  if (!opt) return null;
  return { id: opt.value, name: opt.dataset.name || opt.textContent || opt.value };
}

async function startRecording() {
  const src = selectedSource();
  if (!src) return;

  const result = await window.recorderApi.startRecording({
    sourceId: src.id,
    sourceName: src.name,
    hideNativeCursor: true,
    autoOpenEditor: true,
    selectionBounds: useSelectedArea ? selectedArea : null,
  });

  if (!result?.ok) {
    const diag = shortDiag(result?.ffmpegDiagnostics);
    console.warn("Start failed:", result?.reason || "Unknown error", diag);
    return;
  }

  isRecording = true;
  startBtn.disabled = true;
}

async function toggleArea() {
  if (isRecording) return;

  if (useSelectedArea && selectedArea) {
    useSelectedArea = false;
    setSelectAreaButtonState(false);
    syncAreaPreview();
    return;
  }

  const bounds = await window.recorderApi.pickArea();
  if (!bounds) {
    selectedArea = null;
    useSelectedArea = false;
    setSelectAreaButtonState(false);
    syncAreaPreview();
    return;
  }

  selectedArea = bounds;
  useSelectedArea = true;
  setSelectAreaButtonState(true);
  syncAreaPreview();
}

function onDockKeyDown(e) {
  if (e.key !== "Escape") return;
  if (isRecording) return;
  if (!useSelectedArea && !selectedArea) return;
  e.preventDefault();
  selectedArea = null;
  useSelectedArea = false;
  setSelectAreaButtonState(false);
  if (document.activeElement === selectAreaBtn) {
    selectAreaBtn.blur();
  }
  syncAreaPreview();
}

selectAreaBtn.addEventListener("click", () => {
  toggleArea().catch(() => {});
});
startBtn.addEventListener("click", () => {
  startRecording().catch(() => {});
});
closeBtn.addEventListener("click", () => {
  window.recorderApi.quitApp().catch(() => {});
});

window.recorderApi.onRecordingStopped((result) => {
  handleStopResult(result);
});
window.addEventListener("keydown", onDockKeyDown);

window.addEventListener("beforeunload", () => {
  window.removeEventListener("keydown", onDockKeyDown);
  window.recorderApi.setAreaPreview({ enabled: false, bounds: null }).catch(() => {});
  if (isRecording) {
    window.recorderApi.stopRecording().catch(() => {});
  }
});

loadSources().catch(() => {});
applyStoppedUiState();
setSelectAreaButtonState(false);
syncAreaPreview();
window.addEventListener("load", () => setTimeout(fitDockWindow, 0));
