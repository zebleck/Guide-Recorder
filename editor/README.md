# Guide-Recorder Editor (MVP)

A browser-based starter for a Guide-Recorder-like workflow:

- Record screen (WebM)
- Track interactions during capture (mouse path, left/right click, click-hold, key presses)
- Edit afterwards with:
  - Zoom segments
  - Text overlays
  - Visual click/key indicators in preview

## Important limitation

This web MVP can only capture keyboard/mouse events while the page has focus.
If you need true global input tracking across all apps/windows, use a desktop app (Electron + native hooks such as `uiohook-napi`) and keep this editor as the post-processing layer.

## Run

Use any static server, for example:

```powershell
cd "C:\Users\fabia\Github Repos\Guide-Recorder-Editor"
python -m http.server 5173
```

Open `http://localhost:5173`.

## Next step to production

1. Move recorder to Electron for global input hooks.
2. Replace preview renderer with a frame-accurate timeline renderer.
3. Add export pipeline via FFmpeg (or canvas + MediaRecorder for lightweight exports).

