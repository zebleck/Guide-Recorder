"use strict";

const { spawn } = require("node:child_process");

function send(msg) {
  if (process.send) process.send(msg);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      const chunk = String(d || "");
      stderrTail = (stderrTail + chunk).slice(-12000);
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (line.includes("frame=") || line.includes("fps=") || line.includes("speed=")) {
          send({ type: "progress", line: line.trim() });
        }
      }
    });
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (code=${code}, signal=${signal || "none"}): ${stderrTail}`));
    });
  });
}

process.on("message", async (msg) => {
  if (!msg || msg.type !== "start") return;
  try {
    const args = Array.isArray(msg.args) ? msg.args.map((v) => String(v)) : null;
    const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
    if (!args || !args.length) {
      throw new Error("Worker did not receive ffmpeg args");
    }
    if (payload) {
      const effects = payload.effects && typeof payload.effects === "object" ? payload.effects : {};
      send({
        type: "progress",
        line: `effects events=${Number(effects.events || 0)} zooms=${Number(effects.zooms || 0)} texts=${Number(effects.texts || 0)} `
          + `cursor_offset=(${Number(effects.cursorOffsetX || 0)},${Number(effects.cursorOffsetY || 0)}) `
          + `cursor_hotspot=(${Number(effects.cursorHotspotX || 0)},${Number(effects.cursorHotspotY || 0)})`,
      });
    }
    await runFfmpeg(args);
    send({ type: "done" });
    process.exit(0);
  } catch (err) {
    send({ type: "error", error: err?.message || String(err) });
    process.exit(1);
  }
});
