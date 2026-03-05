/* eslint-disable no-undef */
// This script runs inside a hidden BrowserWindow with nodeIntegration: true.
// It renders text overlays onto a canvas and pipes raw RGBA frames to ffmpeg.

async function renderTextOverlay(specs) {
  const { spawn } = require("child_process");
  const { width, height, fps, durationSec, outPath, texts } = specs;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const frameCount = Math.ceil(durationSec * fps);
  const life = durationSec;

  const proc = spawn("ffmpeg", [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${width}x${height}`,
    "-r", String(fps),
    "-i", "pipe:0",
    "-c:v", "qtrle",
    "-pix_fmt", "argb",
    outPath,
  ], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });

  function textBgRgba(t) {
    const hex = t.bgColor || "#000000";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = (Number(t.bgOpacity ?? 68) / 100).toFixed(2);
    return `rgba(${r},${g},${b},${a})`;
  }

  function textTransitionState(t, tSec) {
    const transition = String(t.transition || "none");
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

  function resolveFont(fontSize, family) {
    const spec = `${fontSize}px '${family}'`;
    try {
      if (document.fonts.check(spec)) return spec;
    } catch { /* ignore */ }
    return `${fontSize}px sans-serif`;
  }

  function textBoxMetrics(renderCtx, textValue, fontSize, pad) {
    const lines = String(textValue ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const safeLines = lines.length ? lines : [""];
    const sampleMetrics = renderCtx.measureText("Mg");
    const ascent = Number(sampleMetrics.actualBoundingBoxAscent || fontSize * 0.78);
    const descentRaw = Number(sampleMetrics.actualBoundingBoxDescent || fontSize * 0.24);
    const descent = Math.min(descentRaw, fontSize * 0.34);
    let w = 0;
    for (const line of safeLines) {
      w = Math.max(w, Number(renderCtx.measureText(line).width || 0));
    }
    const lineHeight = Math.max(fontSize * 1.16, ascent + descent + 1);
    const textBlockH = ascent + descent + Math.max(0, safeLines.length - 1) * lineHeight;
    const padX = pad;
    const padTop = pad;
    const padBottom = Math.max(2, Math.round(pad * 0.2));
    const boxW = w + padX * 2;
    const boxH = textBlockH + padTop + padBottom;
    const boxY = -ascent - padTop;
    return { boxW, boxH, boxY, ascent, descent, padX, padTop, padBottom, lines: safeLines, lineHeight };
  }

  function drawTexts(ctx, tSec, w, h) {
    for (const t of texts) {
      if (tSec < t.startSec || tSec > t.endSec) continue;

      const x = (t.xPct / 100) * w;
      const y = (t.yPct / 100) * h;
      const fontSize = Number(t.fontSize || 22);
      const align = t.align === "center" ? "center" : "left";
      const fontFamily = String(t.fontFamily || "Segoe UI");
      const fontWeight = String(t.fontWeight || "normal") === "bold" ? "bold" : "normal";
      const fontStyle = String(t.fontStyle || "normal") === "italic" ? "italic" : "normal";
      const ts = textTransitionState(t, tSec);

      const pad = 10;
      const fontSpec = `${fontStyle} ${fontWeight} ${resolveFont(fontSize, fontFamily)}`.trim();
      ctx.save();
      ctx.globalAlpha = ts.alpha;
      ctx.translate(x, y);
      ctx.font = fontSpec;
      ctx.textAlign = align;

      const m = textBoxMetrics(ctx, t.value, fontSize, pad);
      const bgX = align === "center" ? -m.boxW / 2 : -pad;
      const pivotX = bgX + m.boxW / 2;
      const pivotY = m.boxY + m.boxH / 2;
      ctx.translate(pivotX, pivotY);
      ctx.scale(ts.scale, ts.scale);
      ctx.translate(-pivotX, -pivotY);

      ctx.fillStyle = textBgRgba(t);
      const bgRadius = Math.max(0, Math.min(14, m.boxH * 0.35));
      ctx.beginPath();
      ctx.roundRect(bgX, m.boxY, m.boxW, m.boxH, bgRadius);
      ctx.fill();

      ctx.fillStyle = t.color || "#ffffff";
      for (let i = 0; i < m.lines.length; i += 1) {
        ctx.fillText(m.lines[i], 0, i * m.lineHeight);
      }
      ctx.restore();
    }
  }

  for (let i = 0; i < frameCount; i += 1) {
    const tSec = i / fps;
    ctx.clearRect(0, 0, width, height);
    drawTexts(ctx, tSec, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const buf = Buffer.from(imageData.data.buffer);
    const ok = proc.stdin.write(buf);
    if (!ok) {
      await new Promise((resolve) => proc.stdin.once("drain", resolve));
    }
  }
  proc.stdin.end();
  await new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`text overlay ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });
  return true;
}
