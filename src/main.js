const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell, globalShortcut, nativeImage } = require("electron");
const fsNative = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

// Windows: avoid noisy/unstable WGC capture path and Chromium log spam.
app.commandLine.appendSwitch("disable-features", "WebRtcAllowWgcDesktopCapturer");
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

let mainWindow = null;
let selectorWindow = null;
let areaPreviewWindow = null;
let countdownWindow = null;
let recordingControlsWindow = null;
let selectorState = null;
let activeSession = null;
let editorServer = null;
const editorServerPort = 5190;
let latestSaved = {
  videoPath: "",
  jsonPath: "",
};

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

function openSelectorWindow() {
  const v = virtualDesktopBounds();
  selectorState = {
    ...v,
    pendingResolve: null,
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

function openRecordingControlsWindow(bounds) {
  const v = virtualDesktopBounds();
  closeRecordingControlsWindow();

  const width = 112;
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

function mapDisplayFromSource(sourceId) {
  const sourceDisplayId = Number(String(sourceId || "").split(":")[1]);
  if (!Number.isFinite(sourceDisplayId)) return screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id === sourceDisplayId) || screen.getPrimaryDisplay();
}

function pushSessionEvent(evt) {
  if (!activeSession) return;
  if (!Number.isFinite(activeSession.startPerf)) return;
  if (activeSession.isPaused) return;
  activeSession.events.push({ t: sessionElapsedMs(activeSession), ...evt });
}

function sessionElapsedMs(session) {
  if (!session || !Number.isFinite(session.startPerf)) return 0;
  const now = performance.now();
  const pausedAccum = Number(session.totalPausedMs || 0);
  const pausedActive = session.isPaused && Number.isFinite(session.pausedAtPerf)
    ? Math.max(0, now - Number(session.pausedAtPerf))
    : 0;
  return Math.max(0, now - Number(session.startPerf) - pausedAccum - pausedActive);
}

function startCursorSampler() {
  if (!activeSession) return;
  activeSession.cursorTimer = setInterval(() => {
    if (!activeSession) return;
    const point = screen.getCursorScreenPoint();
    const norm = normalizePointToBounds(point, activeSession.captureBounds);
    if (!norm) return;

    activeSession.lastCursor = { x: point.x, y: point.y, ...norm };
    pushSessionEvent({ type: "mouse_move", xScreen: point.x, yScreen: point.y, ...norm });
  }, 1000 / 60);
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
    const cursor = activeSession.lastCursor;
    pushSessionEvent({ type: "mouse_down", button: mapHookButton(e.button), ...(cursor || {}) });
  };
  const onMouseUp = (e) => {
    const cursor = activeSession.lastCursor;
    pushSessionEvent({ type: "mouse_up", button: mapHookButton(e.button), ...(cursor || {}) });
  };
  const onKeyDown = (e) => pushSessionEvent({ type: "key_down", keycode: e.keycode });
  const onKeyUp = (e) => pushSessionEvent({ type: "key_up", keycode: e.keycode });

  activeSession.hooks = { onMouseDown, onMouseUp, onKeyDown, onKeyUp };
  uiohook.on("mousedown", onMouseDown);
  uiohook.on("mouseup", onMouseUp);
  uiohook.on("keydown", onKeyDown);
  uiohook.on("keyup", onKeyUp);
  uiohook.start();
  return true;
}

function stopUiohook() {
  if (!uiohook || !activeSession?.hooks) return;
  const { onMouseDown, onMouseUp, onKeyDown, onKeyUp } = activeSession.hooks;
  uiohook.off("mousedown", onMouseDown);
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

function ffmpegArgsFor(bounds, outputPath, hideNativeCursor) {
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
    "30",
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

function ffmpegArgsSelectionCrop(bounds, outputPath, hideNativeCursor) {
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
    "30",
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

function ffmpegArgsFullDesktop(outputPath, hideNativeCursor) {
  return [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "30",
    "-draw_mouse",
    hideNativeCursor ? "0" : "1",
    "-i",
    "desktop",
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

ipcMain.handle("recorder:pickArea", async () => {
  if (selectorWindow) {
    selectorWindow.focus();
  } else {
    openSelectorWindow();
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
      pushSessionEvent({ type: "mouse_move", inFrame: false });
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
    const result = { ok: false, reason: "No active recording" };
    notifyRecordingStopped(result);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return result;
  }

  const session = activeSession;
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

  const durationSec = sessionElapsedMs(session) / 1000;

  const projectJson = {
    recordedMimeType: "video/mp4",
    durationSec,
    sourceId: session.sourceId,
    sourceName: session.sourceName,
    captureBounds: session.captureBounds,
    events: session.events,
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
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }

  const result = {
    ok: true,
    durationSec,
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
    const display = mapDisplayFromSource(sourceId);
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
    activeSession.startPerf = performance.now();
    if (hasSelection) {
      openAreaPreviewWindow(activeSession.captureBounds, true);
    }
    openRecordingControlsWindow(activeSession.captureBounds);
    notifyRecordingState();

    const usingUiohook = startUiohookIfAvailable();
    activeSession.usingUiohook = usingUiohook;
    startCursorSampler();

    const launchFfmpeg = async (args) => {
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
      // In manual selection mode, force selected-area output via crop pipeline.
      startup = await launchFfmpeg(
        ffmpegArgsSelectionCrop(activeSession.captureBounds, videoPath, activeSession.hideNativeCursor)
      );
      if (!startup.started) {
        const diagnostics = (activeSession.ffmpegStderr || "").trim().slice(-4000);
        stopCursorSampler();
        stopUiohook();
        closeRecordingControlsWindow();
        activeSession = null;
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
          ffmpegDiagnostics: diagnostics,
        };
      }
    } else {
      // Attempt 1: region capture for selected display/window.
      startup = await launchFfmpeg(
        ffmpegArgsFor(activeSession.captureBounds, videoPath, activeSession.hideNativeCursor)
      );
    }

    // Attempt 2 fallback: full virtual desktop capture (non-selection mode only).
    if (!hasSelection && !startup.started) {
      const firstDiag = (activeSession.ffmpegStderr || "").trim().slice(-3000);
      activeSession.ffmpegStderr += "\n--- fallback: full desktop capture ---\n";
      const fullBounds = virtualDesktopBounds();
      activeSession.captureBounds = fullBounds;

      startup = await launchFfmpeg(
        ffmpegArgsFullDesktop(videoPath, activeSession.hideNativeCursor)
      );
      if (!startup.started) {
        const diagnostics = (activeSession.ffmpegStderr || "").trim().slice(-4000);
        stopCursorSampler();
        stopUiohook();
        closeRecordingControlsWindow();
        activeSession = null;
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

app.whenReady().then(async () => {
  createWindow();
  try {
    await ensureEditorServer();
  } catch {
    // Keep app usable for recording; open/save status will show editor error on stop.
  }
});
app.on("will-quit", () => {
  closeRecordingControlsWindow();
  closeCountdownWindow();
  closeAreaPreviewWindow();
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  closeRecordingControlsWindow();
  closeCountdownWindow();
  closeAreaPreviewWindow();
  if (process.platform !== "darwin") app.quit();
});

