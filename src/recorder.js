const sourceSelect = document.getElementById("sourceSelect");
const autoOpenEditorInput = document.getElementById("autoOpenEditor");
const hideNativeCursorInput = document.getElementById("hideNativeCursor");
const useSelectedAreaInput = document.getElementById("useSelectedArea");
const selectAreaBtn = document.getElementById("selectAreaBtn");
const areaInfo = document.getElementById("areaInfo");
const refreshBtn = document.getElementById("refreshBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

let isRecording = false;
let lastStartInfo = null;
let selectedArea = null;
let fittedOnce = false;

function fitDockWindow() {
  if (fittedOnce) return;
  const doc = document.documentElement;
  const body = document.body;
  const contentHeight = Math.max(
    doc?.scrollHeight || 0,
    doc?.offsetHeight || 0,
    body?.scrollHeight || 0,
    body?.offsetHeight || 0
  );
  const contentWidth = Math.max(
    doc?.scrollWidth || 0,
    doc?.offsetWidth || 0,
    body?.scrollWidth || 0,
    body?.offsetWidth || 0
  );
  window.recorderApi.fitWindow({
    height: Math.ceil(contentHeight + 6),
    width: Math.ceil(contentWidth + 6),
  }).then(() => {
    fittedOnce = true;
  }).catch(() => {});
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function shortDiag(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const lines = s.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n");
}

function refreshAreaInfo() {
  if (!selectedArea) {
    areaInfo.textContent = "Area: not selected";
    return;
  }
  areaInfo.textContent = `Area: x=${selectedArea.x}, y=${selectedArea.y}, ${selectedArea.width}x${selectedArea.height}`;
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

  setStatus(`Loaded ${sources.length} sources.`);
}

function selectedSource() {
  const opt = sourceSelect.selectedOptions?.[0];
  if (!opt) return null;
  return { id: opt.value, name: opt.dataset.name || opt.textContent || opt.value };
}

async function startRecording() {
  const src = selectedSource();
  if (!src) {
    setStatus("Pick a source first.");
    return;
  }

  try {
    setStatus("Starting native ffmpeg capture...");
    const result = await window.recorderApi.startRecording({
      sourceId: src.id,
      sourceName: src.name,
      hideNativeCursor: Boolean(hideNativeCursorInput.checked),
      autoOpenEditor: Boolean(autoOpenEditorInput.checked),
      selectionBounds: useSelectedAreaInput.checked ? selectedArea : null,
    });

    if (!result.ok) {
      const diag = shortDiag(result.ffmpegDiagnostics);
      setStatus(
        `Start failed: ${result.reason || "Unknown error"}${diag ? `\n\nffmpeg:\n${diag}` : ""}`
      );
      return;
    }

    isRecording = true;
    lastStartInfo = result;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    const hookInfo = result.usingUiohook
      ? "Global click/key: enabled"
      : "Global click/key: unavailable (optional uiohook-napi)";
    const cursorInfo = hideNativeCursorInput.checked
      ? "Native cursor capture: OFF requested"
      : "Native cursor capture: ON";
    const modeInfo =
      result.captureMode === "full-desktop-fallback"
        ? "Capture mode: full desktop fallback"
        : result.captureMode === "manual-selection"
          ? "Capture mode: manual selection"
        : "Capture mode: selected source";
    const stopInfo = result.stopHotkeyRegistered
      ? `Stop hotkey: ${result.stopHotkey}`
      : "Stop hotkey unavailable, use dock Stop";

    setStatus(`Recording...\n${hookInfo}\n${cursorInfo}\n${modeInfo}\n${stopInfo}`);
  } catch (err) {
    setStatus(`Start failed: ${err.message || String(err)}`);
  }
}

async function pickArea() {
  if (isRecording) return;
  try {
    setStatus("Open selector: drag to draw, drag inside to move, handles to resize, Enter to confirm.");
    const bounds = await window.recorderApi.pickArea();
    if (!bounds) {
      setStatus("Area selection canceled.");
      return;
    }
    selectedArea = bounds;
    useSelectedAreaInput.checked = true;
    refreshAreaInfo();
    setStatus("Area selected.");
  } catch (err) {
    setStatus(`Area selection failed: ${err.message || String(err)}`);
  }
}

async function stopRecording() {
  if (!isRecording) return;

  try {
    stopBtn.disabled = true;
    setStatus("Stopping native capture and writing session...");

    const result = await window.recorderApi.stopRecording();
    isRecording = false;
    startBtn.disabled = false;

    if (!result.ok) {
      const diag = shortDiag(result.ffmpegDiagnostics);
      setStatus(
        `Stop failed: ${result.reason || "Unknown error"}${diag ? `\n\nffmpeg:\n${diag}` : ""}`
      );
      return;
    }

    const openInfo = result.editorUrl ? `Editor opened: ${result.editorUrl}` : "Editor auto-open disabled.";
    setStatus(
      `Saved:\n${result.videoPath}\n${result.jsonPath}\nDuration: ${result.durationSec.toFixed(2)}s\n${openInfo}`
    );
  } catch (err) {
    isRecording = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus(`Stop failed: ${err.message || String(err)}`);
  }
}

refreshBtn.addEventListener("click", loadSources);
selectAreaBtn.addEventListener("click", pickArea);
startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);

window.addEventListener("beforeunload", () => {
  if (isRecording) {
    window.recorderApi.stopRecording().catch(() => {});
  }
});

loadSources().catch((err) => setStatus(`Source listing failed: ${err.message || String(err)}`));
refreshAreaInfo();
window.addEventListener("load", () => setTimeout(fitDockWindow, 0));
