const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");

let isPaused = false;
let isRecording = false;

function applyState(state) {
  isPaused = Boolean(state?.isPaused);
  isRecording = Boolean(state?.isRecording);

  pauseBtn.classList.toggle("is-paused", isPaused);
  pauseBtn.title = isPaused ? "Resume recording" : "Pause recording";
  pauseBtn.setAttribute("aria-label", pauseBtn.title);
  pauseBtn.disabled = !isRecording;
  stopBtn.disabled = !isRecording;
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
