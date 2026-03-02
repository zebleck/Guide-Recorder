# Guide-Recorder (Electron)

Desktop-only recorder that hands off editing to the browser editor automatically.

## Workflow

1. Start dock
2. Pick source, optionally select/enable custom area, and record
3. Stop -> auto-save (`.mp4` + `.json`)
4. Browser editor opens and auto-loads the latest saved recording/session

## Run

```powershell
cd "C:\Users\fabia\Github Repos\Guide-Recorder"
npm.cmd install
npm.cmd start
```

## Requirements

- `ffmpeg` must be installed and available on PATH.
- The browser editor repo must exist at sibling path:
  - `C:\Users\zeble\Github Repos\Guide-Recorder-Editor`
  - Required file: `index.html`

## Notes

- Recorder uses native `ffmpeg` (`gdigrab`) instead of WebRTC capture.
- Cursor hiding is controlled by ffmpeg `-draw_mouse` and is much more reliable.
- Area selection supports drag to create, drag to move, and corner-handle resize.
- Dock keeps recorder lightweight: no editor and no timeline UI.
- Global cursor timeline is captured via Electron.
- Global click/key events use optional `uiohook-napi` when available.
- Browser editor server starts with `npm start` and serves at `http://localhost:5190`.
- Recordings are auto-saved in `Videos/Guide-Recorder`.

