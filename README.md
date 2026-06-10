# Apex — Track Designer

Design a racetrack anywhere on Earth, check it against F1/GT circuit
guidelines, then drive it in first person.

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8080>. No installs needed — imagery, elevation and
libraries all load from free public services.

## How to play

1. **Search** a place (press Enter), zoom in — the globe switches to a tilted
   3D terrain view.
2. **✏️ Draw Track**: click to lay out the centerline. Click the first (red)
   point or hit **Close Loop** to finish the circuit. Drag points to refine,
   right-click to delete.
3. Add a **🅿️ pit lane**, set the **🏁 start/finish**, drop **🏟️ grandstands**.
4. Name your corners in the **Turns** panel; pick **F1 / GT / Club** rules and
   watch the homologation checklist.
5. Hit **🏁 DRIVE** — W/A/S/D to drive, R to respawn, Esc to exit.

Tracks auto-save in the browser and can be exported/imported as JSON.
