const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, globalShortcut, nativeImage } = require("electron");
const fsNative = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn, fork } = require("node:child_process");
const os = require("node:os");

// Windows: avoid noisy/unstable WGC capture path and Chromium log spam.
app.commandLine.appendSwitch("disable-features", "WebRtcAllowWgcDesktopCapturer");
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

let mainWindow = null;
let selectorWindow = null;
let areaPreviewWindow = null;
let countdownWindow = null;
let recordingControlsWindow = null;
let recordingStateTicker = null;
let selectorState = null;
let activeSession = null;
let editorServer = null;
const editorServerPort = 5190;
let latestSaved = {
  videoPath: "",
  jsonPath: "",
};
const frameExportJobs = new Map();
const mezzanineJobs = new Map();
let availableVideoEncodersPromise = null;

const editorRoot = path.resolve(__dirname, "..", "editor");
const appLogoPath = path.resolve(__dirname, "..", "logo.svg");
const STOP_HOTKEY = "CommandOrControl+Shift+X";
const FFMPEG_PRESET = "veryfast";
const FFMPEG_CRF = "16";

function notifyRecordingStopped(result) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("recorder:recordingStopped", result);
}

let uiohook = null;
try {
  ({ uIOhook: uiohook } = require("uiohook-napi"));
} catch {
  uiohook = null;
}

function createWindow() {
  const windowIcon = nativeImage.createFromPath(appLogoPath);
  mainWindow = new BrowserWindow({
    width: 520,
    height: 64,
    frame: false,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    icon: windowIcon.isEmpty() ? appLogoPath : windowIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "recorder.html"));
}

function virtualDesktopBounds() {
  const displays = screen.getAllDisplays();
  if (!displays.length) return { x: 0, y: 0, width: 1920, height: 1080 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(320, maxX - minX),
    height: Math.max(240, maxY - minY),
  };
}

function dipPointToScreenPoint(p) {
  try {
    const out = screen.dipToScreenPoint({
      x: Math.round(Number(p?.x || 0)),
      y: Math.round(Number(p?.y || 0)),
    });
    return { x: Number(out.x || 0), y: Number(out.y || 0) };
  } catch {
    return { x: Math.round(Number(p?.x || 0)), y: Math.round(Number(p?.y || 0)) };
  }
}

function dipRectToScreenRect(rect) {
  const x = Number(rect?.x || 0);
  const y = Number(rect?.y || 0);
  const w = Math.max(1, Number(rect?.width || 1));
  const h = Math.max(1, Number(rect?.height || 1));

  const tl = dipPointToScreenPoint({ x, y });
  const br = dipPointToScreenPoint({ x: x + w, y: y + h });

  const left = Math.min(tl.x, br.x);
  const top = Math.min(tl.y, br.y);
  const right = Math.max(tl.x, br.x);
  const bottom = Math.max(tl.y, br.y);

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(2, Math.round(right - left)),
    height: Math.max(2, Math.round(bottom - top)),
  };
}

function normalizeInitialSelectionRect(initialBounds, virtualBounds) {
  if (!initialBounds || !virtualBounds) return null;
  const x = Number(initialBounds.x);
  const y = Number(initialBounds.y);
  const width = Number(initialBounds.width);
  const height = Number(initialBounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width < 80 || height < 80) return null;
  const maxX = Number(virtualBounds.width) - 80;
  const maxY = Number(virtualBounds.height) - 80;
  const localX = Math.max(0, Math.min(maxX, Math.round(x - Number(virtualBounds.x))));
  const localY = Math.max(0, Math.min(maxY, Math.round(y - Number(virtualBounds.y))));
  const clampedW = Math.max(80, Math.min(Number(virtualBounds.width) - localX, Math.round(width)));
  const clampedH = Math.max(80, Math.min(Number(virtualBounds.height) - localY, Math.round(height)));
  return {
    x: localX,
    y: localY,
    width: clampedW,
    height: clampedH,
  };
}

function openSelectorWindow(initialBounds = null) {
  const v = virtualDesktopBounds();
  selectorState = {
    ...v,
    pendingResolve: null,
    initialRect: normalizeInitialSelectionRect(initialBounds, v),
  };

  selectorWindow = new BrowserWindow({
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "selection-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  selectorWindow.setAlwaysOnTop(true, "floating");
  selectorWindow.setMenuBarVisibility(false);
  selectorWindow.loadFile(path.join(__dirname, "selection.html"));
  selectorWindow.once("ready-to-show", () => selectorWindow?.show());
  selectorWindow.on("closed", () => {
    if (selectorState?.pendingResolve) {
      selectorState.pendingResolve(null);
    }
    selectorWindow = null;
    selectorState = null;
  });
}

function closeAreaPreviewWindow() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === mainWindow || w === selectorWindow) continue;
    let shouldClose = false;
    try {
      shouldClose = Boolean(w.__guideRecorderAreaPreview) || w.getTitle() === "Area Preview";
    } catch {
      shouldClose = false;
    }
    if (!shouldClose) continue;
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  areaPreviewWindow = null;
}

function closeRecordingControlsWindow() {
  if (!recordingControlsWindow || recordingControlsWindow.isDestroyed()) {
    recordingControlsWindow = null;
    return;
  }
  recordingControlsWindow.close();
  recordingControlsWindow = null;
}

function recordingStatePayload() {
  return {
    isRecording: Boolean(activeSession?.ffmpegProcess),
    isPaused: Boolean(activeSession?.isPaused),
    elapsedMs: activeSession ? sessionElapsedMs(activeSession) : 0,
  };
}

function notifyRecordingState() {
  const payload = recordingStatePayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("recorder:state", payload);
  }
  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    recordingControlsWindow.webContents.send("recorder:state", payload);
  }
}

function startRecordingStateTicker() {
  stopRecordingStateTicker();
  recordingStateTicker = setInterval(() => {
    notifyRecordingState();
  }, 200);
}

function stopRecordingStateTicker() {
  if (!recordingStateTicker) return;
  clearInterval(recordingStateTicker);
  recordingStateTicker = null;
}

function openRecordingControlsWindow(bounds) {
  const v = virtualDesktopBounds();
  closeRecordingControlsWindow();

  const width = 142;
  const height = 44;
  const cx = Math.round(Number(bounds?.x || v.x) + Number(bounds?.width || v.width) / 2);
  let x = Math.round(cx - width / 2);
  let y = Math.round(Number(bounds?.y || v.y) - height - 10);
  if (y < v.y + 8) y = Math.round(Number(bounds?.y || v.y) + 10);
  x = Math.max(v.x + 8, Math.min(v.x + v.width - width - 8, x));
  y = Math.max(v.y + 8, Math.min(v.y + v.height - height - 8, y));

  recordingControlsWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "recording-controls-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  recordingControlsWindow.__guideRecorderControls = true;
  recordingControlsWindow.setMenuBarVisibility(false);
  recordingControlsWindow.setAlwaysOnTop(true, "screen-saver");
  try {
    recordingControlsWindow.setContentProtection(true);
  } catch {
    // Best effort; unsupported on some platforms/runtime combinations.
  }
  recordingControlsWindow.loadFile(path.join(__dirname, "recording-controls.html"));
  recordingControlsWindow.webContents.once("did-finish-load", () => {
    notifyRecordingState();
  });
  recordingControlsWindow.on("closed", () => {
    recordingControlsWindow = null;
  });
}

function openAreaPreviewWindow(bounds, recording = false) {
  const v = virtualDesktopBounds();
  closeAreaPreviewWindow();
  areaPreviewWindow = new BrowserWindow({
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  areaPreviewWindow.__guideRecorderAreaPreview = true;

  areaPreviewWindow.setMenuBarVisibility(false);
  areaPreviewWindow.setAlwaysOnTop(true, "floating");
  areaPreviewWindow.setIgnoreMouseEvents(true, { forward: true });
  try {
    areaPreviewWindow.setContentProtection(true);
  } catch {
    // Best effort; unsupported on some platforms/runtime combinations.
  }
  areaPreviewWindow.loadFile(path.join(__dirname, "area-preview.html"), {
    query: {
      vx: String(v.x),
      vy: String(v.y),
      x: String(Math.round(bounds.x)),
      y: String(Math.round(bounds.y)),
      w: String(Math.round(bounds.width)),
      h: String(Math.round(bounds.height)),
      recording: recording ? "1" : "0",
    },
  });
  areaPreviewWindow.on("closed", () => {
    areaPreviewWindow = null;
  });
}

function closeCountdownWindow() {
  if (!countdownWindow || countdownWindow.isDestroyed()) {
    countdownWindow = null;
    return;
  }
  countdownWindow.close();
  countdownWindow = null;
}

async function showStartCountdown(bounds, seconds = 3) {
  const v = virtualDesktopBounds();
  const countdownSeconds = Math.max(1, Math.round(seconds));
  closeCountdownWindow();
  countdownWindow = new BrowserWindow({
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  countdownWindow.setMenuBarVisibility(false);
  countdownWindow.setAlwaysOnTop(true, "floating");
  countdownWindow.setIgnoreMouseEvents(true, { forward: true });
  const loadPromise = countdownWindow.loadFile(path.join(__dirname, "countdown.html"), {
    query: {
      vx: String(v.x),
      vy: String(v.y),
      x: String(Math.round(bounds.x)),
      y: String(Math.round(bounds.y)),
      w: String(Math.round(bounds.width)),
      h: String(Math.round(bounds.height)),
      seconds: String(countdownSeconds),
    },
  });

  try {
    await loadPromise;
  } catch {
    // If overlay fails to load for any reason, continue after the same delay.
  }
  await new Promise((resolve) => {
    setTimeout(resolve, countdownSeconds * 1000);
  });
  closeCountdownWindow();
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normalizePointToBounds(point, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    xPct: clamp01((point.x - bounds.x) / bounds.width),
    yPct: clamp01((point.y - bounds.y) / bounds.height),
    inFrame:
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height,
  };
}

function isPointInRecordingControls(point) {
  if (!recordingControlsWindow || recordingControlsWindow.isDestroyed()) return false;
  if (!point) return false;
  let b = null;
  try {
    b = recordingControlsWindow.getBounds();
  } catch {
    return false;
  }
  if (!b) return false;
  return (
    point.x >= b.x &&
    point.x <= b.x + b.width &&
    point.y >= b.y &&
    point.y <= b.y + b.height
  );
}

function cursorSnapshotForSession(session, pointOverride = null) {
  if (!session) return null;
  const point = pointOverride || screen.getCursorScreenPoint();
  const norm = normalizePointToBounds(point, session.captureBounds);
  if (!norm) return null;
  return { x: point.x, y: point.y, ...norm };
}

function pointFromHookEvent(e) {
  const x = Number(e?.x);
  const y = Number(e?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  return null;
}

function mapDisplayFromSource(sourceId, explicitDisplayId = "") {
  const directId = Number(explicitDisplayId);
  if (Number.isFinite(directId) && directId > 0) {
    const direct = screen.getAllDisplays().find((d) => d.id === directId);
    if (direct) return direct;
  }
  const sourceDisplayId = Number(String(sourceId || "").split(":")[1]);
  if (!Number.isFinite(sourceDisplayId)) return screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id === sourceDisplayId) || screen.getPrimaryDisplay();
}

function preferredCaptureFpsForDisplay(display) {
  const raw = Number(display?.displayFrequency || display?.refreshRate || 0);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(12, Math.min(240, Math.round(raw)));
  }
  return 30;
}

function pushSessionEvent(evt) {
  if (!activeSession) return;
  if (!Number.isFinite(activeSession.startPerf)) return;
  if (activeSession.isPaused) return;
  activeSession.events.push({ t: sessionElapsedMs(activeSession), ...evt });
}

function sessionElapsedMs(session, atPerf = null) {
  if (!session || !Number.isFinite(session.startPerf)) return 0;
  const now = Number.isFinite(atPerf) ? Number(atPerf) : performance.now();
  const pausedAccum = Number(session.totalPausedMs || 0);
  const pausedActive = session.isPaused && Number.isFinite(session.pausedAtPerf)
    ? Math.max(0, now - Number(session.pausedAtPerf))
    : 0;
  return Math.max(0, now - Number(session.startPerf) - pausedAccum - pausedActive);
}

function startCursorSampler() {
  if (!activeSession) return;
  const sampleHz = Math.max(12, Math.min(240, Math.round(Number(activeSession.captureFps || 60))));
  const intervalMs = 1000 / sampleHz;
  activeSession.cursorTimer = setInterval(() => {
    if (!activeSession) return;
    const point = screen.getCursorScreenPoint();
    if (isPointInRecordingControls(point)) return;
    const cursor = cursorSnapshotForSession(activeSession, point);
    if (!cursor) return;
    activeSession.lastCursor = cursor;
    pushSessionEvent({ type: "mouse_move", xScreen: cursor.x, yScreen: cursor.y, ...cursor });
  }, intervalMs);
}

function stopCursorSampler() {
  if (activeSession?.cursorTimer) {
    clearInterval(activeSession.cursorTimer);
    activeSession.cursorTimer = null;
  }
}

function startUiohookIfAvailable() {
  if (!uiohook || !activeSession) return false;

  // uiohook button codes: 1=left, 2=right, 3=middle.
  const mapHookButton = (raw) => {
    if (raw === 1) return 0;
    if (raw === 2) return 2;
    if (raw === 3) return 1;
    return 0;
  };

  const onMouseDown = (e) => {
    const point = pointFromHookEvent(e) || screen.getCursorScreenPoint();
    if (isPointInRecordingControls(point)) return;
    const cursor = cursorSnapshotForSession(activeSession, point) || activeSession.lastCursor;
    if (cursor) activeSession.lastCursor = cursor;
    pushSessionEvent({ type: "mouse_down", button: mapHookButton(e.button), ...(cursor || {}) });
  };
  const onMouseMove = (e) => {
    const point = pointFromHookEvent(e) || screen.getCursorScreenPoint();
    if (isPointInRecordingControls(point)) return;
    const cursor = cursorSnapshotForSession(activeSession, point);
    if (!cursor) return;
    activeSession.lastCursor = cursor;
    pushSessionEvent({ type: "mouse_move", xScreen: cursor.x, yScreen: cursor.y, ...cursor });
  };
  const onMouseUp = (e) => {
    const point = pointFromHookEvent(e) || screen.getCursorScreenPoint();
    if (isPointInRecordingControls(point)) return;
    const cursor = cursorSnapshotForSession(activeSession, point) || activeSession.lastCursor;
    if (cursor) activeSession.lastCursor = cursor;
    pushSessionEvent({ type: "mouse_up", button: mapHookButton(e.button), ...(cursor || {}) });
  };
  const onKeyDown = (e) => pushSessionEvent({ type: "key_down", keycode: e.keycode });
  const onKeyUp = (e) => pushSessionEvent({ type: "key_up", keycode: e.keycode });

  activeSession.hooks = { onMouseDown, onMouseMove, onMouseUp, onKeyDown, onKeyUp };
  uiohook.on("mousedown", onMouseDown);
  uiohook.on("mousemove", onMouseMove);
  uiohook.on("mouseup", onMouseUp);
  uiohook.on("keydown", onKeyDown);
  uiohook.on("keyup", onKeyUp);
  uiohook.start();
  return true;
}

function stopUiohook() {
  if (!uiohook || !activeSession?.hooks) return;
  const { onMouseDown, onMouseMove, onMouseUp, onKeyDown, onKeyUp } = activeSession.hooks;
  uiohook.off("mousedown", onMouseDown);
  uiohook.off("mousemove", onMouseMove);
  uiohook.off("mouseup", onMouseUp);
  uiohook.off("keydown", onKeyDown);
  uiohook.off("keyup", onKeyUp);
  uiohook.stop();
  activeSession.hooks = null;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

async function ensureEditorServer() {
  if (editorServer) return `http://localhost:${editorServerPort}`;

  const editorIndexPath = path.join(editorRoot, "index.html");
  try {
    await fs.access(editorIndexPath);
  } catch {
    throw new Error(
      `Editor app not found at ${editorRoot}. Expected file: ${editorIndexPath}`
    );
  }

  editorServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://localhost:${editorServerPort}`);
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/__desktop/export/job" && req.method === "POST") {
        if (!latestSaved.videoPath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "No recording video available for desktop export." }));
          return;
        }
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-export-job-"));
        const outputPath = path.join(tmpDir, "final.mp4");
        try {
          const manifest = await readJsonBody(req);
          await verifyFfmpegAvailable();
          const dims = await probeVideoDimensions(latestSaved.videoPath);
          const args = ffmpegArgsEditorExport(latestSaved.videoPath, outputPath, manifest, dims);
          await new Promise((resolve, reject) => {
            const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            proc.stderr.on("data", (d) => {
              stderr = (stderr + String(d || "")).slice(-10000);
            });
            proc.once("error", reject);
            proc.once("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg export failed (code=${code}): ${stderr}`));
            });
          });
          const stat = await fs.stat(outputPath);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(Number(stat.size || 0)),
            "Cache-Control": "no-store",
          });
          const stream = fsNative.createReadStream(outputPath);
          stream.on("error", () => {
            if (!res.headersSent) res.writeHead(500);
            res.end("Export stream failed");
          });
          stream.pipe(res);
          attachTmpDirCleanup(res, tmpDir);
        } catch (err) {
          await safeRemoveDir(tmpDir);
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Desktop export failed" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/backend/job" && req.method === "POST") {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-backend-export-"));
        const outputPath = path.join(tmpDir, "final.mp4");
        try {
          const manifest = await readJsonBody(req);
          await verifyFfmpegAvailable();
          const mezzanineId = String(manifest?.mezzanineId || "");
          let inputPath = latestSaved.videoPath;
          if (mezzanineId) {
            const job = mezzanineJobs.get(mezzanineId);
            if (!job?.outputPath) {
              throw new Error("Invalid mezzanineId for backend export");
            }
            inputPath = job.outputPath;
          }
          if (!inputPath) {
            throw new Error("No source video available for backend export");
          }
          const startedAt = Date.now();
          let lastProgressLine = "";
          const dims = await probeVideoDimensions(inputPath);
          const args = await ffmpegArgsBackendExport(inputPath, outputPath, manifest, dims, tmpDir);
          await runFfmpegWithRenderWorker(
            args,
            (msg) => {
              if (!msg?.line) return;
              lastProgressLine = String(msg.line).trim();
              console.log("[backend-render-progress]", lastProgressLine);
            },
            60 * 60 * 1000,
            {
              mode: "backend-export",
              effects: {
                events: Array.isArray(manifest?.events) ? manifest.events.length : 0,
                zooms: Array.isArray(manifest?.zooms) ? manifest.zooms.length : 0,
                texts: Array.isArray(manifest?.texts) ? manifest.texts.length : 0,
                cursorOffsetX: Number(manifest?.cursorOffsetX || 0),
                cursorOffsetY: Number(manifest?.cursorOffsetY || 0),
                cursorHotspotX: Number(manifest?.cursorHotspotX || 0),
                cursorHotspotY: Number(manifest?.cursorHotspotY || 0),
              },
            }
          );
          const stat = await fs.stat(outputPath);
          const durationMs = Math.max(0, Date.now() - startedAt);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(Number(stat.size || 0)),
            "Cache-Control": "no-store",
            "X-Guide-Renderer": "backend-worker",
            "X-Guide-Renderer-Effects": "cursor-clicks-zoom-cursor-v1",
            "X-Guide-Renderer-Duration-Ms": String(durationMs),
            "X-Guide-Renderer-Last-Progress": lastProgressLine ? lastProgressLine.slice(0, 180) : "",
          });
          const stream = fsNative.createReadStream(outputPath);
          stream.on("error", () => {
            if (!res.headersSent) res.writeHead(500);
            res.end("Backend export stream failed");
          });
          stream.pipe(res);
          attachTmpDirCleanup(res, tmpDir);
        } catch (err) {
          await safeRemoveDir(tmpDir);
          const msg = String(err?.message || "Backend export failed");
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
        return;
      }

      if (pathname === "/__desktop/transcode/mp4" && req.method === "POST") {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-transcode-"));
        const inputPath = path.join(tmpDir, "input.webm");
        const outputPath = path.join(tmpDir, "output.mp4");
        try {
          const requestedFpsRaw = Number(req.headers["x-export-fps"] || 0);
          const requestedFps = Number.isFinite(requestedFpsRaw) && requestedFpsRaw > 0
            ? Math.max(1, Math.min(240, requestedFpsRaw))
            : 0;
          await writeRequestBodyToFile(req, inputPath);
          await transcodeWebmToMp4(inputPath, outputPath, requestedFps);
          const stat = await fs.stat(outputPath);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(Number(stat.size || 0)),
            "Cache-Control": "no-store",
          });
          const stream = fsNative.createReadStream(outputPath);
          stream.on("error", () => {
            if (!res.headersSent) res.writeHead(500);
            res.end("Transcode stream failed");
          });
          stream.pipe(res);
          attachTmpDirCleanup(res, tmpDir);
        } catch (err) {
          await safeRemoveDir(tmpDir);
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Transcode failed" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/frames/start" && req.method === "POST") {
        try {
          await verifyFfmpegAvailable();
          const body = await readJsonBody(req);
          const fpsRaw = Number(body?.fps || 0);
          if (!Number.isFinite(fpsRaw) || fpsRaw <= 0) {
            throw new Error("Invalid deterministic export FPS");
          }
          const fps = Math.max(1, Math.min(240, fpsRaw));
          const frameWidth = Math.max(2, Math.round(Number(body?.width || 0)));
          const frameHeight = Math.max(2, Math.round(Number(body?.height || 0)));
          if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth < 2 || frameHeight < 2) {
            throw new Error("Invalid frame dimensions for deterministic export");
          }
          const trimStartSec = Math.max(0, Number(body?.trimStartSec || 0));
          const trimEndRaw = Number(body?.trimEndSec || 0);
          const trimEndSec = trimEndRaw > trimStartSec ? trimEndRaw : 0;
          const frameFormatRaw = String(body?.frameFormat || "raw").toLowerCase();
          const frameFormat = frameFormatRaw === "jpeg" || frameFormatRaw === "png" ? frameFormatRaw : "raw";
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-frame-export-"));
          const includeDesktopAudio = Boolean(body?.includeDesktopAudio && latestSaved.videoPath);
          const videoEncoder = await preferredDeterministicVideoEncoder();
          const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          const outputPath = path.join(tmpDir, "final.mp4");
          const args = ["-y"];
          if (frameFormat === "jpeg") {
            args.push(
              "-f", "image2pipe",
              "-vcodec", "mjpeg",
              "-framerate", String(fps),
              "-i", "pipe:0"
            );
          } else if (frameFormat === "png") {
            args.push(
              "-f", "image2pipe",
              "-vcodec", "png",
              "-framerate", String(fps),
              "-i", "pipe:0"
            );
          } else {
            args.push(
              "-f", "rawvideo",
              "-pix_fmt", "rgba",
              "-video_size", `${frameWidth}x${frameHeight}`,
              "-framerate", String(fps),
              "-i", "pipe:0"
            );
          }
          if (includeDesktopAudio) {
            if (trimStartSec > 0) args.push("-ss", trimStartSec.toFixed(3));
            args.push("-i", latestSaved.videoPath);
            args.push("-map", "0:v:0", "-map", "1:a?");
          } else {
            args.push("-map", "0:v:0");
          }
          args.push("-r", String(fps), "-vsync", "cfr");
          pushDeterministicVideoEncoderArgs(args, videoEncoder);
          args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
          if (includeDesktopAudio) {
            args.push("-c:a", "aac", "-b:a", "160k");
          }
          args.push("-shortest", outputPath);
          const ffmpegProc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
          let ffmpegStderr = "";
          ffmpegProc.stderr.on("data", (d) => {
            ffmpegStderr = (ffmpegStderr + String(d || "")).slice(-12000);
          });
          const exitState = { code: null, signal: null };
          const donePromise = new Promise((resolve, reject) => {
            ffmpegProc.once("error", reject);
            ffmpegProc.once("exit", (code, signal) => {
              exitState.code = code;
              exitState.signal = signal;
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg frame-export failed (code=${code}, signal=${signal || "none"}): ${ffmpegStderr}`));
            });
          });
          donePromise.catch(() => {
            // consumed during finalize/abort; avoid unhandled rejection noise
          });
          frameExportJobs.set(jobId, {
            jobId,
            tmpDir,
            outputPath,
            fps,
            trimStartSec,
            trimEndSec,
            sourceVideoPath: includeDesktopAudio ? latestSaved.videoPath : "",
            ffmpegProc,
            ffmpegStderr,
            donePromise,
            exitState,
            writeChain: Promise.resolve(),
            finalized: false,
            queuedBytes: 0,
            frameWidth,
            frameHeight,
            frameFormat,
            videoEncoder,
            frameMaxBytes: frameFormat === "jpeg" || frameFormat === "png"
              ? 16 * 1024 * 1024
              : Math.max(1024, frameWidth * frameHeight * 4 + 4096),
          });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, jobId, videoEncoder }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not start frame export job" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/frames/frame" && req.method === "POST") {
        try {
          const jobId = String(requestUrl.searchParams.get("jobId") || "");
          const index = Math.max(0, Math.floor(Number(requestUrl.searchParams.get("index") || 0)));
          const job = frameExportJobs.get(jobId);
          if (!job) {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "Frame export job not found" }));
            return;
          }
          if (job.finalized) {
            res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "Frame export job already finalized" }));
            return;
          }
          if (String(job.frameFormat || "raw") === "jpeg" || String(job.frameFormat || "raw") === "png") {
            const frameBuffer = await readRequestBodyBuffer(req, Math.max(8 * 1024 * 1024, Number(job.frameMaxBytes || 0)));
            enqueueFrameBufferToJob(job, frameBuffer);
          } else {
            const expectedBytes = Math.max(1, Number(job.frameWidth || 1) * Number(job.frameHeight || 1) * 4);
            const maxBody = Math.max(8 * 1024 * 1024, Number(job.frameMaxBytes || 0));
            const contentLen = Number(req.headers["content-length"] || 0);
            if (contentLen > maxBody) {
              res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "Frame payload too large" }));
              return;
            }
            await enqueueFrameRequestStreamToJob(job, req, expectedBytes);
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, index }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not write frame" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/frames/finalize" && req.method === "POST") {
        let job = null;
        try {
          const body = await readJsonBody(req);
          const jobId = String(body?.jobId || "");
          job = frameExportJobs.get(jobId);
          if (!job) {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "Frame export job not found" }));
            return;
          }
          job.finalized = true;
          await job.writeChain;
          await new Promise((resolve, reject) => {
            const onErr = (err) => reject(err);
            job.ffmpegProc.stdin.once("error", onErr);
            job.ffmpegProc.stdin.end(() => {
              job.ffmpegProc.stdin.off("error", onErr);
              resolve();
            });
          });
          await job.donePromise;
          frameExportJobs.delete(job.jobId);
          const stat = await fs.stat(job.outputPath);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(Number(stat.size || 0)),
            "Cache-Control": "no-store",
          });
          const stream = fsNative.createReadStream(job.outputPath);
          stream.on("error", () => {
            if (!res.headersSent) res.writeHead(500);
            res.end("Frame export stream failed");
          });
          stream.pipe(res);
          attachTmpDirCleanup(res, job.tmpDir);
        } catch (err) {
          if (job) {
            frameExportJobs.delete(job.jobId);
            await safeRemoveDir(job.tmpDir);
          }
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Frame export finalize failed" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/frames/abort" && req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const jobId = String(body?.jobId || "");
          const job = frameExportJobs.get(jobId);
          if (job) {
            frameExportJobs.delete(jobId);
            try {
              job.ffmpegProc.kill("SIGKILL");
            } catch {
              // ignore
            }
            await safeRemoveDir(job.tmpDir);
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not abort frame export job" }));
        }
        return;
      }

      if (pathname === "/__desktop/latest.video") {
        if (!latestSaved.videoPath) {
          res.writeHead(404);
          res.end("No recording available");
          return;
        }
        await waitForFileReady(latestSaved.videoPath, 256, 6000);
        const stat = await fs.stat(latestSaved.videoPath);
        const range = req.headers.range;
        const contentType = mimeFor(latestSaved.videoPath);
        const total = Number(stat.size || 0);

        if (total <= 0) {
          res.writeHead(404, { "Cache-Control": "no-store" });
          res.end("Video file is empty");
          return;
        }

        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
          if (m) {
            let start = null;
            let end = null;
            const startRaw = m[1];
            const endRaw = m[2];

            if (startRaw !== "") start = Number(startRaw);
            if (endRaw !== "") end = Number(endRaw);

            if (start == null && end != null) {
              const suffixLen = Math.max(0, end);
              start = Math.max(0, total - suffixLen);
              end = total - 1;
            } else {
              if (start == null) start = 0;
              if (end == null || end >= total) end = total - 1;
            }

            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < total) {
              res.writeHead(206, {
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Content-Length": String(end - start + 1),
                "Cache-Control": "no-store",
              });
              fsNative.createReadStream(latestSaved.videoPath, { start, end }).pipe(res);
              return;
            }
          }
          // Fall back to full body for malformed or unsatisfiable range requests.
        }

        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": String(total),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        fsNative.createReadStream(latestSaved.videoPath).pipe(res);
        return;
      }

      if (pathname === "/__desktop/export/mezzanine/start" && req.method === "POST") {
        let tmpDir = "";
        try {
          const contentType = String(req.headers["content-type"] || "").toLowerCase();
          const usingJsonSource = contentType.includes("application/json") || contentType === "";
          let sourceVideoPath = "";
          if (usingJsonSource) {
            if (!latestSaved.videoPath) {
              res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "No source recording available" }));
              return;
            }
            sourceVideoPath = latestSaved.videoPath;
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-mezzanine-"));
          } else {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guide-recorder-mezzanine-"));
            const sourceExt = contentType.includes("mp4")
              ? ".mp4"
              : contentType.includes("webm")
                ? ".webm"
                : ".bin";
            sourceVideoPath = path.join(tmpDir, `source${sourceExt}`);
            const uploadedBytes = await writeRequestBodyToFile(req, sourceVideoPath, 2 * 1024 * 1024 * 1024);
            if (!(uploadedBytes > 0)) {
              throw new Error("Uploaded source video is empty");
            }
          }
          await verifyFfmpegAvailable();
          const probedFps = await probeVideoFps(sourceVideoPath).catch(() => 60);
          const targetFps = Math.max(1, Math.min(240, Number(probedFps || 60)));
          const outputPath = path.join(tmpDir, "mezzanine.mp4");
          const args = [
            "-y",
            "-i",
            sourceVideoPath,
            "-map",
            "0:v:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "14",
            "-g",
            "1",
            "-keyint_min",
            "1",
            "-sc_threshold",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-r",
            String(targetFps),
            "-vsync",
            "cfr",
            "-movflags",
            "+faststart",
            "-an",
            outputPath,
          ];
          await new Promise((resolve, reject) => {
            const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            proc.stderr.on("data", (d) => {
              stderr = (stderr + String(d || "")).slice(-12000);
            });
            proc.once("error", reject);
            proc.once("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg mezzanine failed (code=${code}): ${stderr}`));
            });
          });
          const mezzanineId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          mezzanineJobs.set(mezzanineId, {
            mezzanineId,
            tmpDir,
            outputPath,
            fps: targetFps,
            createdAt: Date.now(),
          });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({
            ok: true,
            mezzanineId,
            fps: targetFps,
            url: `/__desktop/export/mezzanine/video?mezzanineId=${encodeURIComponent(mezzanineId)}&t=${Date.now()}`,
          }));
        } catch (err) {
          if (tmpDir) await safeRemoveDir(tmpDir);
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not create mezzanine source" }));
        }
        return;
      }

      if (pathname === "/__desktop/export/mezzanine/video") {
        const mezzanineId = String(requestUrl.searchParams.get("mezzanineId") || "");
        const job = mezzanineJobs.get(mezzanineId);
        if (!job) {
          res.writeHead(404, { "Cache-Control": "no-store" });
          res.end("Mezzanine source not found");
          return;
        }
        const stat = await fs.stat(job.outputPath);
        const total = Number(stat.size || 0);
        const contentType = "video/mp4";
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
          if (m) {
            let start = null;
            let end = null;
            const startRaw = m[1];
            const endRaw = m[2];
            if (startRaw !== "") start = Number(startRaw);
            if (endRaw !== "") end = Number(endRaw);
            if (start == null && end != null) {
              const suffixLen = Math.max(0, end);
              start = Math.max(0, total - suffixLen);
              end = total - 1;
            } else {
              if (start == null) start = 0;
              if (end == null || end >= total) end = total - 1;
            }
            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < total) {
              res.writeHead(206, {
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Content-Length": String(end - start + 1),
                "Cache-Control": "no-store",
              });
              fsNative.createReadStream(job.outputPath, { start, end }).pipe(res);
              return;
            }
          }
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": String(total),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        fsNative.createReadStream(job.outputPath).pipe(res);
        return;
      }

      if (pathname === "/__desktop/export/mezzanine/abort" && req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const mezzanineId = String(body?.mezzanineId || "");
          const job = mezzanineJobs.get(mezzanineId);
          if (job) {
            mezzanineJobs.delete(mezzanineId);
            await safeRemoveDir(job.tmpDir);
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not abort mezzanine source" }));
        }
        return;
      }
      if (pathname === "/__desktop/source/fps") {
        if (!latestSaved.videoPath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "No recording available" }));
          return;
        }
        try {
          const fps = await probeVideoFps(latestSaved.videoPath);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, fps }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err?.message || "Could not probe source fps" }));
        }
        return;
      }
      if (pathname === "/__desktop/latest.json") {
        if (!latestSaved.jsonPath) {
          res.writeHead(404);
          res.end("No session available");
          return;
        }
        const bytes = await fs.readFile(latestSaved.jsonPath);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(bytes);
        return;
      }

      const cleanPath = pathname === "/" ? "/index.html" : pathname;
      const safe = path.normalize(cleanPath).replace(/^([.][.][\\/])+/, "");
      const filePath = path.join(editorRoot, safe);
      if (!filePath.startsWith(editorRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const bytes = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": mimeFor(filePath) });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    editorServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve();
        return;
      }
      reject(err);
    });
    editorServer.listen(editorServerPort, "127.0.0.1", resolve);
  });

  return `http://localhost:${editorServerPort}`;
}

async function ensureRecordingDir() {
  const dir = path.join(app.getPath("videos"), "Guide-Recorder");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function waitForFileReady(filePath, minBytes = 256, timeoutMs = 20000) {
  const started = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    try {
      const stat = await fs.stat(filePath);
      const size = Number(stat.size || 0);
      if (size >= minBytes) {
        if (size === lastSize) stableCount += 1;
        else stableCount = 0;
        lastSize = size;
        if (stableCount >= 2) return true;
      }
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return false;
}

function attachTmpDirCleanup(res, tmpDir) {
  let started = false;
  const trigger = () => {
    if (started) return;
    started = true;
    void safeRemoveDir(tmpDir);
  };
  res.once("finish", trigger);
  res.once("close", trigger);
}

async function safeRemoveDir(dirPath) {
  if (!dirPath) return;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = String(err?.code || "");
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") {
        return;
      }
      await new Promise((r) => setTimeout(r, 80 + attempt * 120));
    }
  }
}

async function writeRequestBodyToFile(req, outputPath) {
  await new Promise((resolve, reject) => {
    const out = fsNative.createWriteStream(outputPath);
    const onErr = (err) => reject(err);
    req.on("error", onErr);
    out.on("error", onErr);
    out.on("finish", resolve);
    req.pipe(out);
  });
}

async function readRequestBodyBuffer(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  return Buffer.concat(chunks);
}

async function writeRequestBodyToFile(req, filePath, maxBytes = 2 * 1024 * 1024 * 1024) {
  const max = Math.max(1, Number(maxBytes || 0));
  const out = fsNative.createWriteStream(filePath);
  let total = 0;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onReqErr);
      out.off("error", onOutErr);
      out.off("drain", onDrain);
      if (err) {
        out.destroy();
        reject(err);
      } else {
        resolve();
      }
    };
    const onReqErr = (err) => finish(err);
    const onOutErr = (err) => finish(err);
    const onDrain = () => {
      if (!done) req.resume();
    };
    const onData = (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > max) {
        finish(new Error("Request body too large"));
        req.destroy();
        return;
      }
      const ok = out.write(chunk);
      if (!ok) req.pause();
    };
    const onEnd = () => {
      out.end(() => finish());
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onReqErr);
    out.once("error", onOutErr);
    out.on("drain", onDrain);
  });
  return total;
}

function enqueueFrameBufferToJob(job, buffer) {
  if (!job?.ffmpegProc?.stdin || !buffer) return;
  job.queuedBytes = Number(job.queuedBytes || 0) + buffer.length;
  job.writeChain = job.writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        if (job.finalized) {
          reject(new Error("Frame export job already finalized"));
          return;
        }
        const stdin = job.ffmpegProc.stdin;
        const onErr = (err) => reject(err);
        stdin.once("error", onErr);
        const ok = stdin.write(buffer, (err) => {
          stdin.off("error", onErr);
          job.queuedBytes = Math.max(0, Number(job.queuedBytes || 0) - buffer.length);
          if (err) reject(err);
          else resolve();
        });
        if (!ok) {
          stdin.once("drain", () => {
            // callback above resolves after write is fully accepted.
          });
        }
      })
  );
  job.writeChain.catch(() => {
    // propagated during finalize via await job.writeChain
  });
}

function enqueueFrameRequestStreamToJob(job, req, expectedBytes) {
  if (!job?.ffmpegProc?.stdin || !req) return Promise.reject(new Error("Invalid frame export job stream"));
  const expected = Math.max(1, Number(expectedBytes || 0));
  job.writeChain = job.writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        if (job.finalized) {
          reject(new Error("Frame export job already finalized"));
          return;
        }
        const stdin = job.ffmpegProc.stdin;
        let total = 0;
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          req.off("data", onData);
          req.off("end", onEnd);
          req.off("error", onReqErr);
          stdin.off("error", onStdinErr);
          if (err) reject(err);
          else resolve();
        };
        const onStdinErr = (err) => finish(err);
        const onReqErr = (err) => finish(err);
        const onData = (chunk) => {
          if (done) return;
          total += chunk.length;
          if (total > expected) {
            finish(new Error(`Frame payload too large (${total} > ${expected})`));
            return;
          }
          job.queuedBytes = Number(job.queuedBytes || 0) + chunk.length;
          const ok = stdin.write(chunk, (err) => {
            job.queuedBytes = Math.max(0, Number(job.queuedBytes || 0) - chunk.length);
            if (err) finish(err);
          });
          if (!ok) {
            req.pause();
            stdin.once("drain", () => {
              if (!done) req.resume();
            });
          }
        };
        const onEnd = () => {
          if (total !== expected) {
            finish(new Error(`Invalid frame byte length (${total}, expected ${expected})`));
            return;
          }
          finish();
        };
        req.on("data", onData);
        req.once("end", onEnd);
        req.once("error", onReqErr);
        stdin.once("error", onStdinErr);
      })
  );
  job.writeChain.catch(() => {
    // propagated during finalize via await job.writeChain
  });
  return job.writeChain;
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function transcodeWebmToMp4(inputPath, outputPath, requestedFps = 0) {
  await verifyFfmpegAvailable();
  let targetFps = requestedFps;
  if (!(targetFps > 0)) {
    try {
      targetFps = await probeVideoFps(inputPath);
    } catch {
      targetFps = 60;
    }
  }
  targetFps = Math.max(1, Math.min(240, Number(targetFps)));
  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-fflags",
      "+genpts",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      `fps=${targetFps},setpts=PTS-STARTPTS`,
      "-vsync",
      "cfr",
      "-r",
      String(targetFps),
      "-avoid_negative_ts",
      "make_zero",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-af",
      "aresample=async=1:first_pts=0,asetpts=N/SR/TB",
      "-shortest",
      outputPath,
    ];
    const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + String(d || "")).slice(-10000);
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode failed (code=${code}): ${stderr}`));
    });
  });
}

async function probeVideoFps(inputPath) {
  return await new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += String(d || "");
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error("ffprobe fps probe failed"));
        return;
      }
      const lines = out
        .split(/\r?\n/g)
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      const parseRatio = (text) => {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
        if (m) {
          const den = Number(m[2]);
          if (den > 0) return Number(m[1]) / den;
        }
        const asNum = Number(text);
        return Number.isFinite(asNum) ? asNum : 0;
      };
      for (const line of lines) {
        const fps = parseRatio(line);
        if (fps > 0 && Number.isFinite(fps)) {
          resolve(fps);
          return;
        }
      }
      reject(new Error("No parseable fps from ffprobe"));
    });
  });
}

function aspectRatioForPreset(preset, sourceW, sourceH) {
  const map = {
    "16:9": 16 / 9,
    "1:1": 1,
    "9:16": 9 / 16,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "21:9": 21 / 9,
  };
  if (!preset || preset === "source") return sourceW / Math.max(1, sourceH);
  return map[preset] || sourceW / Math.max(1, sourceH);
}

async function probeVideoDimensions(inputPath) {
  return await new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      inputPath,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += String(d || "");
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error("ffprobe failed"));
        return;
      }
      const raw = out.trim();
      const m = /^(\d+)x(\d+)$/.exec(raw);
      if (!m) {
        reject(new Error("Could not parse video dimensions"));
        return;
      }
      resolve({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}

async function probeVideoDurationSec(inputPath) {
  return await new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += String(d || "");
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error("ffprobe duration probe failed"));
        return;
      }
      const duration = Number(String(out || "").trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Could not parse video duration"));
        return;
      }
      resolve(duration);
    });
  });
}

function normalizeSessionEventsToDuration(events, sourceDurationMs, targetDurationMs) {
  const source = Number(sourceDurationMs || 0);
  const target = Number(targetDurationMs || 0);
  if (!Array.isArray(events)) return [];
  if (!(source > 0) || !(target > 0)) return events.map((evt) => ({ ...evt }));
  const scale = target / source;
  let lastT = 0;
  return events.map((evt) => {
    const rawT = Number(evt?.t || 0);
    const clamped = Math.max(0, Math.min(target, rawT * scale));
    // Preserve monotonic event ordering after scaling/rounding.
    const t = Math.max(lastT, clamped);
    lastT = t;
    return { ...evt, t };
  });
}

function ffmpegArgsEditorExport(inputPath, outputPath, manifest, dims) {
  const trimStartSec = Math.max(0, Number(manifest?.trimStartSec || 0));
  const trimEndSecRaw = Number(manifest?.trimEndSec || 0);
  const hasTrimEnd = Number.isFinite(trimEndSecRaw) && trimEndSecRaw > trimStartSec;
  const targetAspect = aspectRatioForPreset(String(manifest?.aspectPreset || "source"), dims.width, dims.height);
  const sourceAspect = dims.width / Math.max(1, dims.height);
  let vf = "";
  if (Math.abs(targetAspect - sourceAspect) > 0.0001) {
    if (targetAspect > sourceAspect) {
      vf = `crop=iw:trunc(iw/${targetAspect}/2)*2:(iw-trunc(iw/${targetAspect}/2)*2)/2`;
    } else {
      vf = `crop=trunc(ih*${targetAspect}/2)*2:ih:(iw-trunc(ih*${targetAspect}/2)*2)/2:0`;
    }
  }

  const args = ["-y"];
  if (trimStartSec > 0) {
    args.push("-ss", trimStartSec.toFixed(3));
  }
  args.push("-i", inputPath);
  if (hasTrimEnd) {
    args.push("-to", trimEndSecRaw.toFixed(3));
  }
  if (vf) {
    args.push("-vf", vf);
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath
  );
  return args;
}

function eventRatioFromManifest(evt, axis, captureBounds) {
  const ratioKey = axis === "x" ? "xPct" : "yPct";
  const raw = Number(evt?.[ratioKey]);
  if (Number.isFinite(raw)) {
    if (Math.abs(raw) > 1.5) return Math.max(0, Math.min(1, raw / 100));
    return Math.max(0, Math.min(1, raw));
  }
  const b = captureBounds && typeof captureBounds === "object" ? captureBounds : null;
  if (!b || !Number.isFinite(Number(b.width)) || !Number.isFinite(Number(b.height)) || Number(b.width) <= 0 || Number(b.height) <= 0) {
    return null;
  }
  const screenKey = axis === "x" ? "xScreen" : "yScreen";
  const fallbackKey = axis === "x" ? "x" : "y";
  const v = Number.isFinite(Number(evt?.[screenKey])) ? Number(evt[screenKey]) : Number(evt?.[fallbackKey]);
  if (!Number.isFinite(v)) return null;
  const base = axis === "x" ? Number(b.x || 0) : Number(b.y || 0);
  const size = axis === "x" ? Number(b.width || 0) : Number(b.height || 0);
  if (!(size > 0)) return null;
  return Math.max(0, Math.min(1, (v - base) / size));
}

function parseDataUrlImage(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(raw);
  if (!m) return null;
  const mimeType = String(m[1] || "application/octet-stream").toLowerCase();
  const isSupportedImage = mimeType === "image/png"
    || mimeType === "image/webp"
    || mimeType === "image/jpeg"
    || mimeType === "image/jpg"
    || mimeType === "image/bmp";
  if (!isSupportedImage) return null;
  const isBase64 = Boolean(m[2]);
  const body = String(m[3] || "");
  try {
    const buffer = isBase64
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body), "utf8");
    if (!buffer.length) return null;
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

function extForMimeType(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("bmp")) return ".bmp";
  return ".img";
}

async function probeMediaDimensions(inputPath) {
  return await new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0:s=x",
      inputPath,
    ];
    const p = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d || ""); });
    p.once("error", () => resolve(null));
    p.once("exit", (code) => {
      if (code !== 0) return resolve(null);
      const m = /(\d+)\s*x\s*(\d+)/i.exec(out);
      if (!m) return resolve(null);
      const width = Number(m[1] || 0);
      const height = Number(m[2] || 0);
      if (!(width > 0) || !(height > 0)) return resolve(null);
      resolve({ width, height });
    });
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(null);
    }, 2000);
  });
}

function normalizeCursorMotionModeBackend(value) {
  const v = String(value || "raw").toLowerCase();
  return v === "linear" || v === "spline" ? v : "raw";
}

function normalizeCursorSplineGuideHzBackend(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 18;
  return Math.max(1, Math.min(120, n));
}

function buildPointerEventsForBackend(manifest, dims, trimStartSec, trimDurationSec) {
  const eventList = Array.isArray(manifest?.events) ? manifest.events : [];
  const captureBounds = manifest?.captureBounds && typeof manifest.captureBounds === "object"
    ? manifest.captureBounds
    : null;
  const cursorOffsetX = Number(manifest?.cursorOffsetX || 0);
  const cursorOffsetY = Number(manifest?.cursorOffsetY || 0);
  const points = [];
  for (let i = 0; i < eventList.length; i += 1) {
    const evt = eventList[i];
    const type = String(evt?.type || "");
    if (type !== "mouse_move" && type !== "mouse_down" && type !== "mouse_up") continue;
    if (evt?.inFrame === false) continue;
    const tSecAbs = Number(evt?.t || 0) / 1000;
    const tSec = tSecAbs - trimStartSec;
    if (tSec < 0 || tSec > trimDurationSec) continue;
    const xr = eventRatioFromManifest(evt, "x", captureBounds);
    const yr = eventRatioFromManifest(evt, "y", captureBounds);
    if (xr == null || yr == null) continue;
    const x = Math.max(0, Math.min(dims.width - 1, xr * dims.width + cursorOffsetX));
    const y = Math.max(0, Math.min(dims.height - 1, yr * dims.height + cursorOffsetY));
    points.push({ tSec, x, y, type });
  }
  points.sort((a, b) => a.tSec - b.tSec);
  return points;
}

function reduceKeyframes(points, maxCount) {
  if (!Array.isArray(points) || points.length <= maxCount) return Array.isArray(points) ? points : [];
  const stride = Math.max(1, Math.ceil(points.length / maxCount));
  const out = [];
  for (let i = 0; i < points.length; i += stride) {
    out.push(points[i]);
  }
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function cursorKeyframeBudget(trimDurationSec, targetFps, mode = "raw") {
  const fps = Math.max(1, Math.min(120, Number(targetFps || 30)));
  const sec = Math.max(1, Math.min(4 * 60 * 60, Number(trimDurationSec || 1)));
  const perSec = mode === "raw" ? 10 : Math.min(60, fps);
  const desired = Math.ceil(sec * perSec);
  const floor = mode === "raw" ? 240 : 600;
  const ceiling = mode === "raw" ? 2400 : 12000;
  return Math.max(floor, Math.min(ceiling, desired));
}

function ffmpegFilterPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}


function catmullRom1dBackend(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3
  );
}

function splineAtBackend(anchors, tSec) {
  if (!anchors.length) return null;
  let lo = 0;
  let hi = anchors.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid].tSec <= tSec) {
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
  if (Number(p2.tSec) <= Number(p1.tSec)) return { x: p1.x, y: p1.y };
  const u = Math.max(0, Math.min(1, (tSec - Number(p1.tSec)) / (Number(p2.tSec) - Number(p1.tSec))));
  return {
    x: catmullRom1dBackend(p0.x, p1.x, p2.x, p3.x, u),
    y: catmullRom1dBackend(p0.y, p1.y, p2.y, p3.y, u),
  };
}

function buildCursorKeyframesBackend(manifest, dims, trimStartSec, trimDurationSec, targetFps) {
  const mode = normalizeCursorMotionModeBackend(manifest?.cursorMotionMode);
  const points = buildPointerEventsForBackend(manifest, dims, trimStartSec, trimDurationSec);
  if (!points.length) return [];
  const budget = cursorKeyframeBudget(trimDurationSec, targetFps, mode);
  if (mode === "raw") {
    return reduceKeyframes(points, budget);
  }
  if (mode === "linear") {
    return reduceKeyframes(points, budget);
  }

  const guideHz = normalizeCursorSplineGuideHzBackend(manifest?.cursorSplineGuideHz);
  const stepSec = 1 / Math.max(1, guideHz);
  const anchors = [];
  let nextGuideT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const isClick = p.type === "mouse_down" || p.type === "mouse_up";
    if (!anchors.length) {
      anchors.push({ tSec: p.tSec, x: p.x, y: p.y, click: isClick });
      nextGuideT = p.tSec + stepSec;
      continue;
    }
    if (isClick || p.tSec >= nextGuideT) {
      anchors.push({ tSec: p.tSec, x: p.x, y: p.y, click: isClick });
      nextGuideT = p.tSec + stepSec;
    }
  }
  if (!anchors.length) return reduceKeyframes(points, budget);

  const sampleFps = Math.max(12, Math.min(60, Math.round(Number(targetFps || 30))));
  const sampleStep = 1 / sampleFps;
  const sampled = [];
  for (let t = 0; t <= trimDurationSec + 0.0001; t += sampleStep) {
    const pos = splineAtBackend(anchors, t);
    if (!pos) continue;
    sampled.push({
      tSec: Math.max(0, Math.min(trimDurationSec, t)),
      x: Math.max(0, Math.min(dims.width - 1, Math.round(pos.x))),
      y: Math.max(0, Math.min(dims.height - 1, Math.round(pos.y))),
      type: "mouse_move",
    });
  }
  if (!sampled.length) return reduceKeyframes(points, budget);
  return reduceKeyframes(sampled, budget);
}

function buildSparseTrackBackend(points, mode, dims, trimDurationSec, targetFps, guideHz) {
  if (!points.length) return [];
  if (mode === "raw") {
    return reduceKeyframes(points, 280);
  }
  if (mode === "linear") {
    return reduceKeyframes(points, 220);
  }
  const stepSec = 1 / Math.max(1, guideHz);
  const anchors = [];
  let nextGuideT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const isClick = p.type === "mouse_down" || p.type === "mouse_up";
    if (!anchors.length) {
      anchors.push({ tSec: p.tSec, x: p.x, y: p.y, click: isClick });
      nextGuideT = p.tSec + stepSec;
      continue;
    }
    if (isClick || p.tSec >= nextGuideT) {
      anchors.push({ tSec: p.tSec, x: p.x, y: p.y, click: isClick });
      nextGuideT = p.tSec + stepSec;
    }
  }
  if (!anchors.length) return reduceKeyframes(points, 220);
  const sampleFps = Math.max(12, Math.min(60, Math.round(Number(targetFps || 30))));
  const sampleStep = 1 / sampleFps;
  const sampled = [];
  for (let t = 0; t <= trimDurationSec + 0.0001; t += sampleStep) {
    const pos = splineAtBackend(anchors, t);
    if (!pos) continue;
    sampled.push({
      tSec: Math.max(0, Math.min(trimDurationSec, t)),
      x: Math.max(0, Math.min(dims.width - 1, Math.round(pos.x))),
      y: Math.max(0, Math.min(dims.height - 1, Math.round(pos.y))),
      type: "mouse_move",
    });
  }
  return sampled.length ? reduceKeyframes(sampled, 220) : reduceKeyframes(points, 220);
}

function buildCursorOverlayExpr(track, coord, hotspot, isRaw) {
  if (!track.length) return "0";
  const last = track[track.length - 1];
  const defaultVal = Math.max(0, Number(last[coord]) - hotspot).toFixed(2);
  const parts = [`st(0,${defaultVal})`];
  for (let i = 0; i < track.length - 1; i += 1) {
    const kf = track[i];
    const next = track[i + 1];
    const t0 = Number(kf.tSec);
    const t1 = Number(next.tSec);
    if (!(t1 > t0)) continue;
    const v0 = Math.max(0, Number(kf[coord]) - hotspot);
    if (isRaw) {
      parts.push(`if(between(t,${t0.toFixed(4)},${t1.toFixed(4)}),st(0,${v0.toFixed(2)}),0)`);
    } else {
      const v1 = Math.max(0, Number(next[coord]) - hotspot);
      const rate = (v1 - v0) / (t1 - t0);
      parts.push(`if(between(t,${t0.toFixed(4)},${t1.toFixed(4)}),st(0,${v0.toFixed(2)}+${rate.toFixed(4)}*(t-${t0.toFixed(4)})),0)`);
    }
  }
  parts.push("ld(0)");
  return parts.join(";");
}

function buildCursorCommandTrackBackend(manifest, dims, trimStartSec, trimDurationSec, targetFps) {
  const points = buildPointerEventsForBackend(manifest, dims, trimStartSec, trimDurationSec);
  if (!points.length) return [];
  const mode = normalizeCursorMotionModeBackend(manifest?.cursorMotionMode);
  const guideHz = normalizeCursorSplineGuideHzBackend(manifest?.cursorSplineGuideHz);
  return buildSparseTrackBackend(points, mode, dims, trimDurationSec, targetFps, guideHz);
}

function drawRing(buf, width, height, cx, cy, radius, thickness, r, g, b, alpha) {
  const halfT = thickness * 0.5;
  const rOuter = radius + halfT;
  const rInner = Math.max(0, radius - halfT);
  const minX = Math.max(0, Math.floor(cx - rOuter - 1));
  const maxX = Math.min(width - 1, Math.ceil(cx + rOuter + 1));
  const minY = Math.max(0, Math.floor(cy - rOuter - 1));
  const maxY = Math.min(height - 1, Math.ceil(cy + rOuter + 1));
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < rInner - 1 || dist > rOuter + 1) continue;
      const edgeInner = dist - rInner;
      const edgeOuter = rOuter - dist;
      const aa = Math.min(1, Math.max(0, Math.min(edgeInner, edgeOuter)));
      if (aa <= 0) continue;
      const a = Math.round(alpha * aa * 255);
      if (a <= 0) continue;
      const idx = (py * width + px) * 4;
      const prevA = buf[idx + 3];
      if (a > prevA) {
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = a;
      }
    }
  }
}

function generateClickEffectsOverlay(clicks, dims, fps, durationSec, tmpDir) {
  if (!clicks.length) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const outPath = path.join(tmpDir, "click_effects.mov");
    const w = dims.width;
    const h = dims.height;
    const bytesPerFrame = w * h * 4;
    const frameCount = Math.ceil(durationSec * fps);
    const life = 0.46;

    const proc = spawn("ffmpeg", [
      "-y",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-s", `${w}x${h}`,
      "-r", String(fps),
      "-i", "pipe:0",
      "-c:v", "qtrle",
      "-pix_fmt", "argb",
      outPath,
    ], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });

    const buf = Buffer.alloc(bytesPerFrame, 0);
    let frameIdx = 0;
    let errored = false;

    proc.on("error", (err) => { errored = true; reject(err); });
    proc.on("close", (code) => {
      if (errored) return;
      if (code === 0) resolve(outPath);
      else reject(new Error(`click effects ffmpeg exited with code ${code}`));
    });

    function writeFrame() {
      while (frameIdx < frameCount) {
        const t = frameIdx / fps;
        buf.fill(0);
        let hasContent = false;
        for (let ci = 0; ci < clicks.length; ci += 1) {
          const c = clicks[ci];
          const age = t - c.tSec;
          if (age < 0 || age > life) continue;
          hasContent = true;
          const p = age / life;
          const radius = 12 + p * 34;
          const alpha = 1 - p;
          drawRing(buf, w, h, c.x, c.y, radius, 2, c.r, c.g, c.b, alpha);
        }
        frameIdx += 1;
        if (!hasContent) {
          if (!proc.stdin.write(buf)) { proc.stdin.once("drain", writeFrame); return; }
          continue;
        }
        if (!proc.stdin.write(buf)) { proc.stdin.once("drain", writeFrame); return; }
      }
      proc.stdin.end();
    }
    writeFrame();
  });
}

async function generateTextOverlayVideo(manifest, dims, fps, trimStartSec, trimDurationSec, tmpDir) {
  const texts = Array.isArray(manifest?.texts) ? manifest.texts : [];
  if (!texts.length) return null;
  const adjusted = [];
  for (const t of texts) {
    const startSec = Math.max(0, Number(t.startSec || 0) - trimStartSec);
    const endSec = Math.max(0, Number(t.endSec || 0) - trimStartSec);
    if (!(endSec > startSec) || endSec < 0 || startSec > trimDurationSec) continue;
    if (!String(t.value || "").trim()) continue;
    adjusted.push({ ...t, startSec, endSec });
  }
  if (!adjusted.length) return null;

  const outPath = path.join(tmpDir, "text_overlay.mov");
  const renderScript = await fs.readFile(path.join(__dirname, "text-overlay-render.js"), "utf8");

  const win = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  try {
    await win.loadURL("data:text/html,<!DOCTYPE html><html><body></body></html>");
    await win.webContents.executeJavaScript(renderScript);
    await win.webContents.executeJavaScript(
      `renderTextOverlay(${JSON.stringify({
        width: dims.width,
        height: dims.height,
        fps,
        durationSec: trimDurationSec,
        outPath,
        texts: adjusted,
      })})`
    );
    return outPath;
  } finally {
    win.destroy();
  }
}

function buildBackendZoomScaleExpr(manifest, trimStartSec, trimDurationSec) {
  const zooms = Array.isArray(manifest?.zooms) ? manifest.zooms : [];
  if (!zooms.length) return "1";

  // Heuristic: if zoom times exceed trimmed duration, treat them as absolute media timeline.
  let hasBeyondTrimmedRange = false;
  for (const z of zooms) {
    const s = Number(z?.startSec || 0);
    const e = Number(z?.endSec || 0);
    if (s > trimDurationSec + 0.5 || e > trimDurationSec + 0.5) {
      hasBeyondTrimmedRange = true;
      break;
    }
  }
  const baseShift = hasBeyondTrimmedRange ? trimStartSec : 0;

  const normalized = [];
  for (const z of zooms) {
    const rawStart = Number(z?.startSec || 0) - baseShift;
    const rawEnd = Number(z?.endSec || 0) - baseShift;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const startSec = Math.max(0, rawStart);
    const endSec = Math.min(trimDurationSec, rawEnd);
    if (!(endSec > startSec)) continue;
    const durSec = endSec - startSec;
    const targetScale = Math.max(1, Number(z?.scale || 1));
    const easeSecRaw = Math.max(0, Number(z?.easeMs || 0)) / 1000;
    const easeSec = Math.min(easeSecRaw, durSec * 0.5);
    normalized.push({ startSec, endSec, targetScale, easeSec });
  }
  if (!normalized.length) return "1";
  normalized.sort((a, b) => a.startSec - b.startSec);

  let expr = "1";
  for (const z of normalized) {
    const s = z.startSec.toFixed(3);
    const e = z.endSec.toFixed(3);
    const scale = z.targetScale.toFixed(4);
    let segExpr = scale;
    if (z.easeSec > 0.0005) {
      const ei = (z.startSec + z.easeSec).toFixed(3);
      const eo = (z.endSec - z.easeSec).toFixed(3);
      const ease = z.easeSec.toFixed(3);
      segExpr = [
        `if(lt(t,${ei}),`,
        `(1+(${scale}-1)*((t-${s})/${ease})),`,
        `if(gt(t,${eo}),(1+(${scale}-1)*((${e}-t)/${ease})),${scale}))`,
      ].join("");
    }
    expr = `if(between(t,${s},${e}),${segExpr},(${expr}))`;
  }
  return expr;
}

async function ffmpegArgsBackendExport(inputPath, outputPath, manifest, dims, tmpDir) {
  const trimStartSec = Math.max(0, Number(manifest?.trimStartSec || 0));
  const trimEndSecRaw = Number(manifest?.trimEndSec || 0);
  const hasTrimEnd = Number.isFinite(trimEndSecRaw) && trimEndSecRaw > trimStartSec;
  const trimDurationSec = hasTrimEnd ? Math.max(0, trimEndSecRaw - trimStartSec) : Number.POSITIVE_INFINITY;

  // Determine effective video duration for loop-fade
  let effectiveDurationSec = trimDurationSec;
  if (!Number.isFinite(effectiveDurationSec)) {
    try {
      const probedDur = await probeVideoDurationSec(inputPath);
      effectiveDurationSec = Math.max(0, probedDur - trimStartSec);
    } catch { effectiveDurationSec = 0; }
  }
  const loopFadeSec = 0.5;
  const targetAspect = aspectRatioForPreset(String(manifest?.aspectPreset || "source"), dims.width, dims.height);
  const sourceAspect = dims.width / Math.max(1, dims.height);
  let cropFilter = "";
  if (Math.abs(targetAspect - sourceAspect) > 0.0001) {
    if (targetAspect > sourceAspect) {
      cropFilter = `crop=iw:trunc(iw/${targetAspect}/2)*2:(iw-trunc(iw/${targetAspect}/2)*2)/2`;
    } else {
      cropFilter = `crop=trunc(ih*${targetAspect}/2)*2:ih:(iw-trunc(ih*${targetAspect}/2)*2)/2:0`;
    }
  }

  const eventList = Array.isArray(manifest?.events) ? manifest.events : [];
  const parsedCursor = parseDataUrlImage(manifest?.cursorTextureDataUrl);
  const useCustomCursor = Boolean(parsedCursor && parsedCursor.buffer.length > 0);
  const fpsRaw = Number(manifest?.renderFps || 0);
  const targetFps = Number.isFinite(fpsRaw) && fpsRaw > 0
    ? Math.max(1, Math.min(240, fpsRaw))
    : 0;
  const captureBounds = manifest?.captureBounds && typeof manifest.captureBounds === "object"
    ? manifest.captureBounds
    : null;
  const cursorOffsetX = Number(manifest?.cursorOffsetX || 0);
  const cursorOffsetY = Number(manifest?.cursorOffsetY || 0);
  const cursorHotspotX = Number(manifest?.cursorHotspotX || 0);
  const cursorHotspotY = Number(manifest?.cursorHotspotY || 0);
  const cursorSize = 6;
  const cursorHalf = Math.floor(cursorSize / 2);

  const pointerKeyframes = buildCursorKeyframesBackend(manifest, dims, trimStartSec, trimDurationSec, targetFps);
  const cursorCommandTrack = useCustomCursor
    ? buildCursorCommandTrackBackend(manifest, dims, trimStartSec, trimDurationSec, targetFps)
    : [];

  const overlayFilters = [];
  if (!useCustomCursor) {
    for (let i = 0; i < pointerKeyframes.length; i += 1) {
      const kf = pointerKeyframes[i];
      const nextT = i + 1 < pointerKeyframes.length ? pointerKeyframes[i + 1].tSec : trimDurationSec;
      if (!(nextT > kf.tSec)) continue;
      const x = Math.max(0, kf.x - cursorHalf);
      const y = Math.max(0, kf.y - cursorHalf);
      overlayFilters.push(
        `drawbox=x=${x}:y=${y}:w=${cursorSize}:h=${cursorSize}:color=white@0.95:t=fill:enable='between(t,${kf.tSec.toFixed(3)},${nextT.toFixed(3)})'`
      );
    }
  }

  const clickEvents = [];
  for (let i = 0; i < eventList.length; i += 1) {
    const evt = eventList[i];
    if (String(evt?.type || "") !== "mouse_down") continue;
    if (evt?.inFrame === false) continue;
    const tSecAbs = Number(evt?.t || 0) / 1000;
    const tSec = tSecAbs - trimStartSec;
    if (tSec < 0 || tSec > trimDurationSec) continue;
    const xr = eventRatioFromManifest(evt, "x", captureBounds);
    const yr = eventRatioFromManifest(evt, "y", captureBounds);
    if (xr == null || yr == null) continue;
    const x = Math.max(0, Math.min(dims.width - 1, Math.round(xr * dims.width + cursorOffsetX)));
    const y = Math.max(0, Math.min(dims.height - 1, Math.round(yr * dims.height + cursorOffsetY)));
    const button = Number(evt?.button || 0);
    const [r, g, b] = button === 2 ? [249, 95, 98] : button === 1 ? [255, 200, 0] : [22, 163, 74];
    clickEvents.push({ tSec, x, y, r, g, b });
    if (clickEvents.length >= 800) break;
  }

  const vfParts = [];
  if (overlayFilters.length) vfParts.push(...overlayFilters);
  const zoomScaleExpr = buildBackendZoomScaleExpr(manifest, trimStartSec, trimDurationSec);
  if (zoomScaleExpr !== "1") {
    vfParts.push(
      `crop=w='trunc(iw/(${zoomScaleExpr})/2)*2':h='trunc(ih/(${zoomScaleExpr})/2)*2':x='(iw-ow)/2':y='(ih-oh)/2'`,
      `scale=${Math.max(2, Math.round(Number(dims.width || 0)))}:${Math.max(2, Math.round(Number(dims.height || 0)))}`
    );
  }
  if (cropFilter) vfParts.push(cropFilter);

  const overlayFps = targetFps > 0 ? targetFps : 60;
  const textOverlayPath = await generateTextOverlayVideo(manifest, dims, overlayFps, trimStartSec, trimDurationSec, tmpDir);
  const clickOverlayPath = clickEvents.length
    ? await generateClickEffectsOverlay(clickEvents, dims, overlayFps, trimDurationSec, tmpDir)
    : null;

  const args = ["-y"];
  if (trimStartSec > 0) {
    args.push("-ss", trimStartSec.toFixed(3));
  }
  args.push("-i", inputPath);
  let cursorImagePath = "";
  let nextInputIdx = 1;
  if (parsedCursor && parsedCursor.buffer.length > 0) {
    const candidatePath = path.join(tmpDir, `cursor${extForMimeType(parsedCursor.mimeType)}`);
    await fs.writeFile(candidatePath, parsedCursor.buffer);
    const probed = await probeMediaDimensions(candidatePath);
    const maxCursorSide = 512;
    const maxCursorArea = 512 * 512;
    const looksReasonableCursor = Boolean(
      probed
      && probed.width > 0
      && probed.height > 0
      && probed.width <= maxCursorSide
      && probed.height <= maxCursorSide
      && (probed.width * probed.height) <= maxCursorArea
      && probed.width <= Math.max(16, Math.floor(dims.width * 0.6))
      && probed.height <= Math.max(16, Math.floor(dims.height * 0.6))
    );
    if (looksReasonableCursor) {
      cursorImagePath = candidatePath;
      args.push("-loop", "1", "-i", cursorImagePath);
      nextInputIdx += 1;
    }
  }
  let textInputIdx = -1;
  if (textOverlayPath) {
    textInputIdx = nextInputIdx;
    args.push("-i", textOverlayPath);
    nextInputIdx += 1;
  }
  let clickInputIdx = -1;
  if (clickOverlayPath) {
    clickInputIdx = nextInputIdx;
    args.push("-i", clickOverlayPath);
    nextInputIdx += 1;
  }
  if (hasTrimEnd) {
    args.push("-to", trimEndSecRaw.toFixed(3));
  }
  const needsFilterGraph = vfParts.length || cursorImagePath || textOverlayPath || clickOverlayPath;
  if (needsFilterGraph) {
    const baseChain = vfParts.length ? vfParts.join(",") : "null";
    let graph = `[0:v]${baseChain}[basev]`;
    let lastLabel = "basev";
    if (cursorImagePath && cursorCommandTrack.length > 0) {
      const cursorIdx = 1;
      const isRaw = normalizeCursorMotionModeBackend(manifest?.cursorMotionMode) === "raw";
      const xExpr = buildCursorOverlayExpr(cursorCommandTrack, "x", cursorHotspotX, isRaw);
      const yExpr = buildCursorOverlayExpr(cursorCommandTrack, "y", cursorHotspotY, isRaw);
      graph += `;[${cursorIdx}:v]format=rgba,setpts=PTS-STARTPTS[cursorv]`;
      graph += `;[${lastLabel}][cursorv]overlay=x='${xExpr}':y='${yExpr}':eval=frame[withcursor]`;
      lastLabel = "withcursor";
    }
    if (textInputIdx >= 0) {
      graph += `;[${textInputIdx}:v]format=rgba,setpts=PTS-STARTPTS[textsv]`;
      graph += `;[${lastLabel}][textsv]overlay=0:0:format=auto:shortest=1[withtext]`;
      lastLabel = "withtext";
    }
    if (clickInputIdx >= 0) {
      graph += `;[${clickInputIdx}:v]format=rgba,setpts=PTS-STARTPTS[clicksv]`;
      graph += `;[${lastLabel}][clicksv]overlay=0:0:format=auto:shortest=1[withclicks]`;
      lastLabel = "withclicks";
    }
    // Loop-fade: crossfade end of video into the first frame
    const canLoopFade = effectiveDurationSec > loopFadeSec * 2;
    if (canLoopFade) {
      const xfadeOffset = Math.max(0, effectiveDurationSec - loopFadeSec);
      graph += `;[${lastLabel}]split[_main][_forfirst]`;
      graph += `;[_forfirst]trim=start=0:end=${(1 / Math.max(1, overlayFps)).toFixed(6)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${loopFadeSec.toFixed(3)}[_firstframe]`;
      graph += `;[_main][_firstframe]xfade=transition=fade:duration=${loopFadeSec.toFixed(3)}:offset=${xfadeOffset.toFixed(3)}[vout]`;
    } else {
      graph += `;[${lastLabel}]copy[vout]`;
    }
    const filterScriptPath = path.join(tmpDir, "backend-filter-complex.ffscript");
    await fs.writeFile(filterScriptPath, graph, "utf8");
    args.push("-filter_complex_script", filterScriptPath, "-map", "[vout]");
    args.push("-map", "0:a?");
  } else {
    const canLoopFadeSimple = effectiveDurationSec > loopFadeSec * 2;
    if (canLoopFadeSimple) {
      const xfadeOffset = Math.max(0, effectiveDurationSec - loopFadeSec);
      const graph =
        `[0:v]split[_main][_forfirst]`
        + `;[_forfirst]trim=start=0:end=${(1 / 30).toFixed(6)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${loopFadeSec.toFixed(3)}[_firstframe]`
        + `;[_main][_firstframe]xfade=transition=fade:duration=${loopFadeSec.toFixed(3)}:offset=${xfadeOffset.toFixed(3)}[vout]`;
      const filterScriptPath = path.join(tmpDir, "backend-filter-complex.ffscript");
      await fs.writeFile(filterScriptPath, graph, "utf8");
      args.push("-filter_complex_script", filterScriptPath, "-map", "[vout]");
      args.push("-map", "0:a?");
    } else {
      args.push("-map", "0:v:0", "-map", "0:a?");
    }
  }
  if (targetFps > 0) {
    args.push("-r", String(targetFps), "-vsync", "cfr");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-tune",
    "zerolatency",
    "-x264-params",
    "bframes=0:rc-lookahead=0:sync-lookahead=0",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath
  );
  return args;
}

async function verifyFfmpegAvailable() {
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.once("error", reject);
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg is not available on PATH"));
    });
  });
}

async function runFfmpegWithRenderWorker(args, onProgress = null, timeoutMs = 60 * 60 * 1000, workerPayload = null) {
  return await new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "render-worker.js");
    const worker = fork(workerPath, [], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        worker.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error("Backend render worker timed out"));
    }, Math.max(1000, Number(timeoutMs || 0)));
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    worker.once("error", (err) => finish(err));
    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "progress") {
        if (onProgress) onProgress(msg);
        return;
      }
      if (msg.type === "done") {
        finish();
        return;
      }
      if (msg.type === "error") {
        finish(new Error(String(msg.error || "Backend render worker failed")));
      }
    });
    worker.once("exit", (code, signal) => {
      if (done) return;
      if (code === 0) finish();
      else finish(new Error(`Backend render worker exited (code=${code}, signal=${signal || "none"})`));
    });
    worker.send({
      type: "start",
      args,
      payload: workerPayload && typeof workerPayload === "object" ? workerPayload : null,
    });
  });
}

async function availableVideoEncoders() {
  if (!availableVideoEncodersPromise) {
    availableVideoEncodersPromise = new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-hide_banner", "-encoders"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => {
        out += String(d || "");
      });
      proc.stderr.on("data", (d) => {
        out += String(d || "");
      });
      proc.once("error", reject);
      proc.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error("Could not read ffmpeg encoder list"));
          return;
        }
        const found = new Set();
        for (const m of out.matchAll(/\b(h264_mf|h264_nvenc|h264_qsv|libx264)\b/g)) {
          found.add(String(m[1]));
        }
        resolve(found);
      });
    }).catch((err) => {
      availableVideoEncodersPromise = null;
      throw err;
    });
  }
  return await availableVideoEncodersPromise;
}

async function preferredDeterministicVideoEncoder() {
  const encoders = await availableVideoEncoders().catch(() => new Set(["libx264"]));
  const order = process.platform === "win32"
    ? ["h264_mf", "h264_nvenc", "h264_qsv", "libx264"]
    : ["h264_nvenc", "h264_qsv", "libx264"];
  for (const encoder of order) {
    if (encoders.has(encoder)) return encoder;
  }
  return "libx264";
}

function pushDeterministicVideoEncoderArgs(args, encoder) {
  args.push("-c:v", encoder);
  if (encoder === "libx264") {
    args.push(
      "-preset",
      "superfast",
      "-tune",
      "zerolatency",
      "-x264-params",
      "bframes=0:rc-lookahead=0:sync-lookahead=0",
      "-crf",
      "18"
    );
    return;
  }
  if (encoder === "h264_nvenc") {
    args.push("-preset", "p5", "-cq", "18", "-b:v", "0");
    return;
  }
  if (encoder === "h264_qsv") {
    args.push("-global_quality", "18");
  }
}

function ffmpegArgsFor(bounds, outputPath, hideNativeCursor, captureFps = 30) {
  const normalizedFps = String(Math.max(12, Math.min(240, Math.round(Number(captureFps || 30)))));
  const px = dipRectToScreenRect(bounds);
  const safeX = Math.max(0, Number(px.x || 0));
  const safeY = Math.max(0, Number(px.y || 0));
  const safeW = Math.max(320, Number(px.width || 1920));
  const safeH = Math.max(240, Number(px.height || 1080));

  return [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    normalizedFps,
    "-offset_x",
    String(safeX),
    "-offset_y",
    String(safeY),
    "-video_size",
    `${safeW}x${safeH}`,
    "-draw_mouse",
    hideNativeCursor ? "0" : "1",
    "-i",
    "desktop",
    "-r",
    normalizedFps,
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    FFMPEG_PRESET,
    "-crf",
    FFMPEG_CRF,
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof+faststart",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];
}

function ffmpegArgsSelectionCrop(bounds, outputPath, hideNativeCursor, captureFps = 30) {
  const normalizedFps = String(Math.max(12, Math.min(240, Math.round(Number(captureFps || 30)))));
  const evenFloor = (n) => Math.floor(Number(n || 0) / 2) * 2;
  const vPx = dipRectToScreenRect(virtualDesktopBounds());
  const bPx = dipRectToScreenRect(bounds);
  const fullW = evenFloor(Math.max(320, Number(vPx.width || 1920)));
  const fullH = evenFloor(Math.max(240, Number(vPx.height || 1080)));
  const offX = evenFloor(Math.round(Number(vPx.x || 0)));
  const offY = evenFloor(Math.round(Number(vPx.y || 0)));

  let cropX = evenFloor(Math.max(0, Math.min(fullW - 2, Math.round(Number(bPx.x || 0) - offX))));
  let cropY = evenFloor(Math.max(0, Math.min(fullH - 2, Math.round(Number(bPx.y || 0) - offY))));
  let cropW = evenFloor(Math.max(80, Math.min(fullW - cropX, Math.round(Number(bPx.width || 320)))));
  let cropH = evenFloor(Math.max(80, Math.min(fullH - cropY, Math.round(Number(bPx.height || 240)))));

  // Keep crop rectangle valid after even rounding.
  if (cropX + cropW > fullW) cropW = evenFloor(fullW - cropX);
  if (cropY + cropH > fullH) cropH = evenFloor(fullH - cropY);
  if (cropW < 80) cropW = 80;
  if (cropH < 80) cropH = 80;

  return [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    normalizedFps,
    "-offset_x",
    String(offX),
    "-offset_y",
    String(offY),
    "-video_size",
    `${fullW}x${fullH}`,
    "-draw_mouse",
    hideNativeCursor ? "0" : "1",
    "-i",
    "desktop",
    "-vf",
    `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    "-r",
    normalizedFps,
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    FFMPEG_PRESET,
    "-crf",
    FFMPEG_CRF,
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof+faststart",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];
}

function ffmpegArgsFullDesktop(outputPath, hideNativeCursor, captureFps = 30) {
  const normalizedFps = String(Math.max(12, Math.min(240, Math.round(Number(captureFps || 30)))));
  return [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    normalizedFps,
    "-draw_mouse",
    hideNativeCursor ? "0" : "1",
    "-i",
    "desktop",
    "-r",
    normalizedFps,
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    FFMPEG_PRESET,
    "-crf",
    FFMPEG_CRF,
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof+faststart",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];
}

async function waitForFfmpegStartup(proc, timeoutMs = 1600) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish({ started: true }), timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ started: false, code, signal });
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      finish({ started: false, code: -1, signal: "error", error: err?.message || String(err) });
    });
  });
}

function stopFfmpegProcess(proc) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    proc.once("exit", finish);
    proc.once("close", finish);

    // 1) Graceful quit so ffmpeg can finalize container metadata.
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write("q\n");
      } else {
        proc.kill("SIGINT");
      }
    } catch {
      // ignore and continue to forced paths
    }

    // 2) Force-kill process tree on Windows if graceful stop stalls.
    setTimeout(() => {
      if (done) return;
      try {
        const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("close", () => {
          // If ffmpeg still does not emit exit/close, we resolve anyway below.
        });
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 2500);

    // 3) Never hang UI forever.
    setTimeout(() => {
      finish();
    }, 7000);
  });
}

ipcMain.handle("recorder:listSources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 240, height: 135 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id }));
});

ipcMain.handle("recorder:fitWindow", async (_evt, payload) => {
  if (!mainWindow) return { ok: false };
  const requestedHeight = Number(payload?.height || 0);
  const requestedWidth = Number(payload?.width || 0);
  const [currentW] = mainWindow.getContentSize();
  const width = Math.max(360, Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : currentW);
  const height = Math.max(40, Math.min(140, Number.isFinite(requestedHeight) ? Math.round(requestedHeight) : 48));
  mainWindow.setContentSize(width, height, true);
  if (!mainWindow.isVisible()) mainWindow.show();
  return { ok: true, width, height };
});

ipcMain.handle("recorder:getState", async () => {
  return recordingStatePayload();
});

ipcMain.handle("recorder:pickArea", async (_evt, payload) => {
  const initialBounds = payload?.initialBounds || null;
  if (selectorWindow) {
    selectorWindow.close();
    openSelectorWindow(initialBounds);
  } else {
    openSelectorWindow(initialBounds);
  }

  return await new Promise((resolve) => {
    if (!selectorState) {
      resolve(null);
      return;
    }
    selectorState.pendingResolve = resolve;
  });
});

ipcMain.handle("recorder:togglePause", async () => {
  if (!activeSession?.ffmpegProcess) {
    return { ok: false, reason: "No active recording" };
  }
  const proc = activeSession.ffmpegProcess;
  if (!proc.stdin || proc.stdin.destroyed) {
    return { ok: false, reason: "Pause control is unavailable for this session" };
  }
  try {
    proc.stdin.write("p\n");
    if (!activeSession.isPaused) {
      activeSession.isPaused = true;
      activeSession.pausedAtPerf = performance.now();
    } else {
      const pausedAt = Number(activeSession.pausedAtPerf || 0);
      if (pausedAt > 0) {
        activeSession.totalPausedMs = Number(activeSession.totalPausedMs || 0) + Math.max(0, performance.now() - pausedAt);
      }
      activeSession.isPaused = false;
      activeSession.pausedAtPerf = null;
    }
    notifyRecordingState();
    return { ok: true, isPaused: activeSession.isPaused };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
});

ipcMain.handle("recorder:setAreaPreview", async (_evt, payload) => {
  const enabled = Boolean(payload?.enabled);
  const recording = Boolean(payload?.recording);
  const b = payload?.bounds;
  const hasBounds =
    b &&
    Number.isFinite(Number(b.x)) &&
    Number.isFinite(Number(b.y)) &&
    Number.isFinite(Number(b.width)) &&
    Number.isFinite(Number(b.height)) &&
    Number(b.width) > 10 &&
    Number(b.height) > 10;

  if (!enabled || !hasBounds) {
    closeAreaPreviewWindow();
    return { ok: true, visible: false };
  }

  openAreaPreviewWindow({
    x: Number(b.x),
    y: Number(b.y),
    width: Number(b.width),
    height: Number(b.height),
  }, recording);
  return { ok: true, visible: true };
});

ipcMain.handle("recorder:quit", async () => {
  try {
    if (activeSession?.ffmpegProcess) {
      activeSession.autoOpenEditor = false;
      await stopRecordingInternal();
    }
  } catch {
    // Continue quit path even if stop/save fails.
  }
  app.quit();
  return { ok: true };
});

ipcMain.handle("selector:getContext", async () => {
  if (!selectorState) return null;
  return {
    x: selectorState.x,
    y: selectorState.y,
    width: selectorState.width,
    height: selectorState.height,
    initialRect: selectorState.initialRect || null,
  };
});

ipcMain.on("selector:confirm", (_evt, rect) => {
  if (!selectorState?.pendingResolve) return;
  const x = Math.round(Number(rect?.x || 0) + selectorState.x);
  const y = Math.round(Number(rect?.y || 0) + selectorState.y);
  const width = Math.max(80, Math.round(Number(rect?.width || 0)));
  const height = Math.max(80, Math.round(Number(rect?.height || 0)));

  const result = { x, y, width, height };
  selectorState.pendingResolve(result);
  selectorState.pendingResolve = null;
  selectorWindow?.close();
});

ipcMain.on("selector:cancel", () => {
  if (selectorState?.pendingResolve) {
    selectorState.pendingResolve(null);
    selectorState.pendingResolve = null;
  }
  selectorWindow?.close();
});

async function stopRecordingInternal() {
  if (!activeSession || !activeSession.ffmpegProcess) {
    closeRecordingControlsWindow();
    stopRecordingStateTicker();
    notifyRecordingState();
    const result = { ok: false, reason: "No active recording" };
    notifyRecordingStopped(result);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return result;
  }

  const session = activeSession;
  const stopPerf = performance.now();
  closeRecordingControlsWindow();
  closeCountdownWindow();
  stopCursorSampler();
  stopUiohook();
  globalShortcut.unregister(STOP_HOTKEY);

  await stopFfmpegProcess(session.ffmpegProcess);
  const ready = await waitForFileReady(session.videoPath, 256, 20000);
  if (!ready) {
    const diagnostics = (session.ffmpegStderr || "").trim().slice(-3000);
    activeSession = null;
    stopRecordingStateTicker();
    notifyRecordingState();
    const result = {
      ok: false,
      reason: "Recording file did not finalize in time. Try a slightly longer recording.",
      ffmpegDiagnostics: diagnostics,
    };
    notifyRecordingStopped(result);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return result;
  }

  const measuredDurationSec = Math.max(0, sessionElapsedMs(session, stopPerf) / 1000);
  let recordedDurationSec = measuredDurationSec;
  try {
    const probedDuration = await probeVideoDurationSec(session.videoPath);
    if (Number.isFinite(probedDuration) && probedDuration > 0) {
      recordedDurationSec = probedDuration;
    }
  } catch {
    // Fall back to local session clock if ffprobe duration probe fails.
  }
  const normalizedEvents = normalizeSessionEventsToDuration(
    session.events,
    measuredDurationSec * 1000,
    recordedDurationSec * 1000
  );

  const projectJson = {
    recordedMimeType: "video/mp4",
    durationSec: recordedDurationSec,
    sourceId: session.sourceId,
    sourceName: session.sourceName,
    captureBounds: session.captureBounds,
    events: normalizedEvents,
    zooms: [],
    texts: [],
  };

  await fs.writeFile(session.jsonPath, JSON.stringify(projectJson, null, 2), "utf8");

  latestSaved = {
    videoPath: session.videoPath,
    jsonPath: session.jsonPath,
  };

  let editorUrl = "";
  let editorOpenError = "";
  if (session.autoOpenEditor) {
    try {
      const baseUrl = await ensureEditorServer();
      editorUrl = `${baseUrl}/?autoloaddesktop=1&t=${Date.now()}`;
      await shell.openExternal(editorUrl);
    } catch (err) {
      editorOpenError = err?.message || String(err);
    }
  }

  const ffmpegDiagnostics = session.ffmpegStderr;
  activeSession = null;
  stopRecordingStateTicker();
  notifyRecordingState();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }

  const result = {
    ok: true,
    durationSec: recordedDurationSec,
    videoPath: latestSaved.videoPath,
    jsonPath: latestSaved.jsonPath,
    editorUrl,
    editorOpenError,
    hideNativeCursor: session.hideNativeCursor,
    usingUiohook: Boolean(session.usingUiohook),
    ffmpegDiagnostics,
  };
  notifyRecordingStopped(result);
  return result;
}

ipcMain.handle("recorder:startRecording", async (_evt, payload) => {
  if (activeSession?.ffmpegProcess) {
    return { ok: false, reason: "Recording already in progress" };
  }

  try {
    await verifyFfmpegAvailable();

    const sourceId = payload?.sourceId;
    const display = mapDisplayFromSource(sourceId, payload?.sourceDisplayId);
    const captureFps = preferredCaptureFpsForDisplay(display);
    const selection = payload?.selectionBounds;
    const hasSelection =
      selection &&
      Number.isFinite(Number(selection.x)) &&
      Number.isFinite(Number(selection.y)) &&
      Number(selection.width) > 40 &&
      Number(selection.height) > 40;

    const captureBounds = hasSelection
      ? {
          x: Math.round(Number(selection.x)),
          y: Math.round(Number(selection.y)),
          width: Math.round(Number(selection.width)),
          height: Math.round(Number(selection.height)),
        }
      : display.bounds;
    const recordingDir = await ensureRecordingDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const videoPath = path.join(recordingDir, `guide-recorder-${stamp}.mp4`);
    const jsonPath = videoPath.replace(/\.mp4$/i, ".json");

    activeSession = {
      sourceId,
      sourceName: payload?.sourceName || sourceId,
      startPerf: null,
      captureBounds,
      events: [],
      lastCursor: null,
      cursorTimer: null,
      hooks: null,
      autoOpenEditor: Boolean(payload?.autoOpenEditor),
      hideNativeCursor: Boolean(payload?.hideNativeCursor),
      videoPath,
      jsonPath,
      ffmpegProcess: null,
      ffmpegStderr: "",
      usingUiohook: false,
      captureFps,
      isPaused: false,
      pausedAtPerf: null,
      totalPausedMs: 0,
    };

    closeAreaPreviewWindow();
    if (mainWindow) mainWindow.hide();
    if (hasSelection) {
      openAreaPreviewWindow(activeSession.captureBounds, false);
    }
    await showStartCountdown(activeSession.captureBounds, 3);
    if (hasSelection) {
      openAreaPreviewWindow(activeSession.captureBounds, true);
    }
    openRecordingControlsWindow(activeSession.captureBounds);
    notifyRecordingState();
    startRecordingStateTicker();
    const usingUiohook = startUiohookIfAvailable();
    activeSession.usingUiohook = usingUiohook;
    if (!usingUiohook) {
      startCursorSampler();
    }

    const launchFfmpeg = async (args) => {
      // Anchor input-event timestamps to the exact capture launch attempt.
      // If we retry with a fallback mode, we reset the timeline to that attempt.
      if (activeSession) {
        activeSession.startPerf = performance.now();
        activeSession.events = [];
        activeSession.lastCursor = null;
      }
      const ffmpegProcess = spawn("ffmpeg", args, {
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });

      activeSession.ffmpegProcess = ffmpegProcess;
      ffmpegProcess.stderr.on("data", (d) => {
        if (!activeSession) return;
        const msg = String(d || "");
        activeSession.ffmpegStderr = (activeSession.ffmpegStderr + msg).slice(-12000);
      });

      ffmpegProcess.once("error", (err) => {
        if (!activeSession) return;
        activeSession.ffmpegStderr += `\nspawn error: ${err.message || String(err)}`;
      });

      return await waitForFfmpegStartup(ffmpegProcess);
    };

    let captureMode = hasSelection ? "manual-selection" : "region";
    let startup = null;

    if (hasSelection) {
      // In manual selection mode, capture selected area directly for better throughput.
      startup = await launchFfmpeg(
        ffmpegArgsFor(activeSession.captureBounds, videoPath, activeSession.hideNativeCursor, activeSession.captureFps)
      );
      if (!startup.started) {
        const firstDiag = (activeSession.ffmpegStderr || "").trim().slice(-3000);
        activeSession.ffmpegStderr += "\n--- fallback: selected-area crop capture ---\n";
        startup = await launchFfmpeg(
          ffmpegArgsSelectionCrop(activeSession.captureBounds, videoPath, activeSession.hideNativeCursor, activeSession.captureFps)
        );
        if (!startup.started) {
          const diagnostics = (activeSession.ffmpegStderr || "").trim().slice(-4000);
          stopCursorSampler();
          stopUiohook();
          closeRecordingControlsWindow();
          activeSession = null;
          stopRecordingStateTicker();
          notifyRecordingState();
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
          if (hasSelection) {
            openAreaPreviewWindow(captureBounds, false);
          }
          return {
            ok: false,
            reason:
              `ffmpeg failed to start selected-area capture (code=${startup.code}, signal=${startup.signal || "none"}).` +
              (startup.error ? ` ${startup.error}` : ""),
            ffmpegDiagnostics: `${firstDiag}\n\n${diagnostics}`,
          };
        }
        captureMode = "manual-selection-crop-fallback";
      }
    } else {
      // Attempt 1: region capture for selected display/window.
      startup = await launchFfmpeg(
        ffmpegArgsFor(activeSession.captureBounds, videoPath, activeSession.hideNativeCursor, activeSession.captureFps)
      );
    }

    // Attempt 2 fallback: full virtual desktop capture (non-selection mode only).
    if (!hasSelection && !startup.started) {
      const firstDiag = (activeSession.ffmpegStderr || "").trim().slice(-3000);
      activeSession.ffmpegStderr += "\n--- fallback: full desktop capture ---\n";
      const fullBounds = virtualDesktopBounds();
      activeSession.captureBounds = fullBounds;

      startup = await launchFfmpeg(
        ffmpegArgsFullDesktop(videoPath, activeSession.hideNativeCursor, activeSession.captureFps)
      );
      if (!startup.started) {
        const diagnostics = (activeSession.ffmpegStderr || "").trim().slice(-4000);
        stopCursorSampler();
        stopUiohook();
        closeRecordingControlsWindow();
        activeSession = null;
        stopRecordingStateTicker();
        notifyRecordingState();
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        if (hasSelection) {
          openAreaPreviewWindow(captureBounds, false);
        }
        return {
          ok: false,
          reason:
            `ffmpeg failed to start capture (code=${startup.code}, signal=${startup.signal || "none"}).` +
            (startup.error ? ` ${startup.error}` : ""),
          ffmpegDiagnostics: `${firstDiag}\n\n${diagnostics}`,
        };
      }
      captureMode = "full-desktop-fallback";
    }

    globalShortcut.unregister(STOP_HOTKEY);
    const stopHotkeyRegistered = globalShortcut.register(STOP_HOTKEY, () => {
      stopRecordingInternal().catch(() => {});
    });
    return {
      ok: true,
      usingUiohook,
      captureBounds: activeSession.captureBounds,
      outputPath: videoPath,
      captureMode,
      stopHotkey: STOP_HOTKEY,
      stopHotkeyRegistered,
    };
  } catch (err) {
    closeRecordingControlsWindow();
    closeCountdownWindow();
    if (activeSession) {
      stopCursorSampler();
      stopUiohook();
      activeSession = null;
    }
    stopRecordingStateTicker();
    notifyRecordingState();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    globalShortcut.unregister(STOP_HOTKEY);
    return { ok: false, reason: err.message || String(err) };
  }
});

ipcMain.handle("recorder:stopRecording", async () => {
  return await stopRecordingInternal();
});

async function cancelRecordingInternal() {
  if (!activeSession || !activeSession.ffmpegProcess) {
    closeRecordingControlsWindow();
    stopRecordingStateTicker();
    notifyRecordingState();
    const result = { ok: false, reason: "No active recording", cancelled: true };
    notifyRecordingStopped(result);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return result;
  }

  const session = activeSession;
  const videoPath = session.videoPath;
  const jsonPath = session.jsonPath;
  closeRecordingControlsWindow();
  closeCountdownWindow();
  stopCursorSampler();
  stopUiohook();
  globalShortcut.unregister(STOP_HOTKEY);

  await stopFfmpegProcess(session.ffmpegProcess);
  activeSession = null;
  stopRecordingStateTicker();
  notifyRecordingState();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }

  try {
    await fs.unlink(videoPath);
  } catch {
    // ignore if file doesn't exist or already deleted
  }
  try {
    await fs.unlink(jsonPath);
  } catch {
    // ignore
  }

  const result = { ok: false, reason: "Cancelled", cancelled: true };
  notifyRecordingStopped(result);
  return result;
}

ipcMain.handle("recorder:cancelRecording", async () => {
  return await cancelRecordingInternal();
});

app.whenReady().then(async () => {
  createWindow();
  try {
    await ensureEditorServer();
  } catch {
    // Keep app usable for recording; open/save status will show editor error on stop.
  }
});
app.on("will-quit", () => {
  stopRecordingStateTicker();
  closeRecordingControlsWindow();
  closeCountdownWindow();
  closeAreaPreviewWindow();
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  stopRecordingStateTicker();
  closeRecordingControlsWindow();
  closeCountdownWindow();
  closeAreaPreviewWindow();
  if (process.platform !== "darwin") app.quit();
});

