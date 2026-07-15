# Apex — Track Designer

Design a racetrack anywhere on Earth, check it against F1/GT circuit
guidelines, then drive it in first person.

## ▶️ Play it now

**https://dpigott2012.github.io/apex-track-designer/**

No install, no account — it runs entirely in your browser. Tracks auto-save
in your browser, and you can export/import them as JSON files to share.

## How to play

1. **Search** a place (press Enter), zoom in — the globe switches to a tilted
   3D terrain view.
2. **✏️ Draw Track**: click to lay out the centerline. Click the first (red)
   point or hit **Close Loop** to finish the circuit. Drag points to refine,
   right-click (or Alt+click) to delete. Clicking a closed track inserts a
   new point so you can add corners.
3. Add a **🅿️ pit lane** (clicks near the track snap to its edge), set the
   **🏁 start/finish**, drop **🏟️ grandstands**.
4. Name your corners in the **Turns** panel; pick **F1 / GT / Club** rules and
   watch the homologation checklist.
5. Hit **🏁 DRIVE** — W/A/S/D to drive, R to respawn, Esc to exit. The road
   follows the real elevation of wherever you built your track.

## Run it locally (development)

No build tools needed — everything loads from CDNs. Serve the folder with any
static file server. On Windows, just double-click `Start Game.bat` (or run
`powershell -ExecutionPolicy Bypass -File serve.ps1`) and open
<http://localhost:8080>.
