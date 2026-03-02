const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const timeLabel = document.getElementById("timeLabel");

let isPaused = false;
let isRecording = false;

function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function applyState(state) {
  isPaused = Boolean(state?.isPaused);
  isRecording = Boolean(state?.isRecording);
  const elapsedMs = Number(state?.elapsedMs || 0);

  pauseBtn.classList.toggle("is-paused", isPaused);
  pauseBtn.title = isPaused ? "Resume recording" : "Pause recording";
  pauseBtn.setAttribute("aria-label", pauseBtn.title);
  pauseBtn.disabled = !isRecording;
  stopBtn.disabled = !isRecording;
  timeLabel.textContent = formatClock(elapsedMs);
}

pauseBtn.addEventListener("click", async () => {
  if (!isRecording) return;
  pauseBtn.disabled = true;
  try {
    const result = await window.recordingControlsApi.togglePause();
    if (result?.ok) {
      applyState({ isRecording: true, isPaused: Boolean(result.isPaused) });
    }
  } catch {
    // ignore
  } finally {
    if (isRecording) pauseBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  if (!isRecording) return;
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  try {
    await window.recordingControlsApi.stopRecording();
  } catch {
    // ignore
  }
});

window.recordingControlsApi.onState((state) => {
  applyState(state);
});

window.recordingControlsApi.getState().then((state) => {
  applyState(state);
}).catch(() => {
  applyState({ isRecording: false, isPaused: false });
});
