# Apex — Track Designer & Driving Game

Design a real racetrack anywhere on Earth on a 3D satellite map, validate it
against F1/GT homologation rules, then drive it in first person.

## Hard constraints

- **No build tools, no Node, no Python on this machine.** Everything is plain
  ES modules loaded from CDN (MapLibre GL 5.6 UMD, Three.js 0.160 via import
  map in `index.html`). Do not introduce npm/`node_modules` — this folder is
  OneDrive-synced and the machine has no Node anyway.
- **No API keys.** Imagery is Esri World Imagery tiles, elevation is AWS
  Terrarium tiles, geocoding is Nominatim — all free/keyless. Keep it that way
  unless the user explicitly opts into a keyed provider (e.g. Google 3D Tiles).
- Plain JavaScript, not TypeScript (no build step to strip types).

## Run / test

- Serve with `serve.ps1` (PowerShell HttpListener, port 8080). The preview
  server config is `.claude/launch.json` (name: `trackgame`).
- **Hidden-tab testing:** browser previews run in a hidden tab where
  `requestAnimationFrame` and timers are throttled, which stalls MapLibre and
  Three. Load the app as `/?bg=1` to enable the MessageChannel-based rAF shim
  in `index.html`. Screenshots of the hidden preview time out — verify with
  `preview_eval` + `map.queryRenderedFeatures` / HUD DOM reads instead.
- `window.__app` exposes `{ map, editor, state, demoTrack(), enterDrive() }`
  for scripted testing. `demoTrack()` drops a known-good 4 km closed circuit
  at the current map center.

## Architecture

- `index.html` — UI shell, CSS, CDN imports, bg-tab rAF shim.
- `src/geo.js` — pure math: local ENU projection, Catmull-Rom sampling,
  curvature, corner detection, longest straight, quasi-static lap-time sim,
  Esri tile stitching for the drive-mode ground texture.
- `src/editor.js` — MapLibre map + `TrackEditor` (modes: view/track/pit/start/
  stand; drag points, right-click delete). Owns all map sources/layers and
  recomputes `derived` (spline, metrics, corners, pit, lap est) on every edit.
- `src/validate.js` — homologation presets (f1/gt/club) + check list. Values
  are simplified from FIA Appendix O; directional, not official.
- `src/drive.js` — Three.js first-person mode built from `derived`: road
  ribbon mesh, kerbs on corners, start gantry, grandstand boxes, satellite
  ground plane, arcade car physics, lap timing, minimap.
- `src/main.js` — glue: panels, toolbar, search, localStorage persistence
  (`apex.track.v1`), JSON export/import, drive-mode entry.

## Gotchas learned the hard way

- MapLibre 5 cannot render circle/symbol layers when terrain is enabled on the
  **globe** projection. The map uses globe when zoomed out and swaps to
  mercator+terrain past zoom 9 (`updateProjection` in editor.js). Never swap
  projection mid-animation (`map.isMoving()`) — it freezes the camera and
  `idle` never fires.
- Track state lives in `state` (plain JSON, saved/exported verbatim); all
  geometry is *derived* and never persisted. Coordinates are `[lng, lat]`;
  local meters are x=east / y=north; Three.js maps that to (x, y-up, -z).
- Grandstands are stored as track anchors `{t: lap fraction, offset: signed
  lateral meters}` so they follow track edits; they're wiped if the track is
  cleared. Legacy `{lng, lat, angle}` stands are migrated in `_rebuildStands`.
- Drive mode fetches Terrarium DEM for real elevation (`makeElevationSampler`
  in geo.js): road/kerbs follow a smoothed profile, gravity acts along the
  grade, and going >60 m off track auto-respawns the car.
- Mobile (≤820px): right panel becomes a bottom sheet (#sheetHandle toggles
  .open), toolbar goes horizontal/icon-only, New/Import/Export relocate into
  the sheet via `placeFileBtns()`. Touch editing lives in editor.js
  (`_onTouchStart/Move/End`: drag = move point, 600ms long-press = delete).
  Drive touch controls are buttons that synthesize the same KeyboardEvents
  the physics reads — shown when `#drive` has the `touch` class (pointer:
  coarse). CSS transitions don't advance in the hidden test pane — assert on
  class + computed style with `transition: none`, not on animated position.
- Terrain must never poke through the road: the ground mesh carves a flat
  apron 0.3 m *below* road height extending one vertex-spacing past the kerbs
  (so no triangle can rise across the ribbon), using the **minimum** road
  elevation among all track sections within reach (switchbacks!), then ramps
  to true DEM height over ~45 m. Verify with the `window.__drive` debug handle
  (set while driving): scan ground vertices within `width/2 + 2.5` of a sample
  and assert `y <= elevArr[i] - 0.05`.
