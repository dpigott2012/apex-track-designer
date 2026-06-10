// App glue: UI bindings, persistence, search, mode switching, drive launch.
import { createMap, TrackEditor, emptyState } from './editor.js';
import { validate } from './validate.js';
import { fmtTime, fmtDist } from './geo.js';

const SAVE_KEY = 'apex.track.v1';
const $ = (id) => document.getElementById(id);

let state = loadState() || emptyState();
const map = createMap('map');
const editor = new TrackEditor(map, state, onDerived);
let driveSession = null;

// ---------- panels ----------
function onDerived(d) {
  saveSoon();
  renderStats(d);
  renderChecks(d);
  renderTurns(d);
  $('btnDrive').disabled = !(d && d.closed);
  $('btnDrive').title = d && d.closed ? '' : 'Close the track loop first';
}

function renderStats(d) {
  const rows = [];
  const add = (k, v) => rows.push(`<div class="stat"><span>${k}</span><span class="v">${v}</span></div>`);
  if (!d) {
    add('Length', '—');
    add('Status', 'Pick a spot & draw');
  } else {
    add('Length', fmtDist(d.len));
    add('Status', d.closed ? 'Closed circuit' : 'Open — keep drawing');
    add('Corners', d.corners.length ? `${d.corners.length} (${d.corners.filter(c => c.dir === 'L').length}L / ${d.corners.filter(c => c.dir === 'R').length}R)` : '—');
    add('Longest straight', d.straight ? fmtDist(d.straight) : '—');
    add('Pit lane', d.pitLen ? fmtDist(d.pitLen) : '—');
    if (d.lap) {
      add('Est. lap time', fmtTime(d.lap.time));
      add('Est. top speed', `${Math.round(d.lap.vTop * 3.6)} km/h`);
    }
  }
  $('stats').innerHTML = rows.join('');
}

function renderChecks(d) {
  const checks = validate(d, state.preset);
  $('checks').innerHTML = checks.map((c) => {
    const cls = c.ok == null ? '' : c.ok ? 'ok' : 'bad';
    const ic = c.ok == null ? '·' : c.ok ? '✔' : '✘';
    return `<div class="check ${cls}"><span class="ic">${ic}</span><span>${c.label}</span><span class="val">${c.value}</span></div>`;
  }).join('');
}

function renderTurns(d) {
  const el = $('turns');
  if (!d || !d.corners.length) {
    el.innerHTML = '<div class="hint">Close the loop to auto-detect corners.</div>';
    return;
  }
  el.innerHTML = d.corners.map((c) => `
    <div class="turnRow">
      <span class="tno">T${c.n}</span><span class="tdir">${c.dir}</span>
      <input data-turn="${c.n}" placeholder="name this turn…" value="${(state.turnNames[c.n] || '').replace(/"/g, '&quot;')}" />
      <span class="trad">${c.radius}m</span>
    </div>`).join('');
  el.querySelectorAll('input[data-turn]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const n = inp.dataset.turn;
      if (inp.value.trim()) state.turnNames[n] = inp.value.trim();
      else delete state.turnNames[n];
      editor.rebuild();
    });
  });
}

// ---------- toolbar ----------
document.querySelectorAll('#toolbar button[data-mode]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#toolbar button[data-mode]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    editor.setMode(b.dataset.mode);
  });
});
$('btnClose').addEventListener('click', () => editor.closeLoop());
$('btnUndo').addEventListener('click', () => editor.undo());
$('btnClear').addEventListener('click', () => {
  if (confirm('Clear the whole track?')) {
    editor.clearAll();
    $('trackName').value = state.name;
  }
});
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'z' && !driveSession) { e.preventDefault(); editor.undo(); }
});

// ---------- top bar ----------
$('trackName').addEventListener('change', () => {
  state.name = $('trackName').value || 'Untitled Circuit';
  saveSoon();
});
$('width').addEventListener('input', () => {
  state.widthM = parseFloat($('width').value);
  $('widthVal').textContent = `${state.widthM} m`;
  editor.rebuildSoon();
});
$('preset').addEventListener('change', () => {
  state.preset = $('preset').value;
  editor.rebuild();
});

$('btnNew').addEventListener('click', () => {
  if (!confirm('Start a new track? Current one is exported/saved in browser.')) return;
  exportJson(true);
  editor.clearAll();
  $('trackName').value = state.name;
});

$('btnExport').addEventListener('click', () => exportJson(false));
$('btnImport').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    Object.assign(state, emptyState(), data);
    $('trackName').value = state.name;
    $('preset').value = state.preset;
    $('width').value = state.widthM;
    $('widthVal').textContent = `${state.widthM} m`;
    editor.rebuild();
    flyToTrack();
  } catch (err) { alert('Could not read that file: ' + err.message); }
  e.target.value = '';
});

function exportJson(silent) {
  if (!state.points.length && silent) return;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name.replace(/[^\w\- ]/g, '').trim() || 'track'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- search (Nominatim) ----------
$('search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = $('search').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.style.display = 'block';
  box.innerHTML = '<div>Searching…</div>';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
    const results = await r.json();
    box.innerHTML = results.length ? '' : '<div>No results</div>';
    for (const res of results) {
      const div = document.createElement('div');
      div.textContent = res.display_name;
      div.addEventListener('click', () => {
        box.style.display = 'none';
        map.flyTo({ center: [+res.lon, +res.lat], zoom: 14.5, pitch: 55, duration: 3500, essential: true });
      });
      box.appendChild(div);
    }
  } catch { box.innerHTML = '<div>Search failed</div>'; }
});
document.addEventListener('click', (e) => {
  if (!$('searchWrap').contains(e.target)) $('searchResults').style.display = 'none';
});

function flyToTrack() {
  if (!state.points.length) return;
  const lngs = state.points.map((p) => p[0]), lats = state.points.map((p) => p[1]);
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 120, pitch: 50, duration: 2500 });
}

// ---------- drive mode ----------
$('btnDrive').addEventListener('click', enterDrive);
$('hudExit').addEventListener('click', () => driveSession && driveSession.stop());

async function enterDrive() {
  if (!editor.derived || !editor.derived.closed || driveSession) return;
  $('loading').classList.add('on');
  try {
    const { startDrive } = await import('./drive.js');
    $('drive').classList.add('on');
    driveSession = await startDrive({
      state,
      derived: editor.derived,
      container: $('driveCanvas'),
      hud: {
        speed: $('hudSpeed'), gear: $('hudGear'), time: $('hudTime'),
        last: $('hudLast'), best: $('hudBest'), lap: $('hudLap'),
        turn: $('hudTurn'), msg: $('hudMsg'), minimap: $('minimap'),
      },
      onExit: () => {
        driveSession = null;
        $('drive').classList.remove('on');
      },
    });
  } catch (err) {
    console.error('drive failed', err);
    alert('Drive mode failed: ' + err.message);
    $('drive').classList.remove('on');
    driveSession = null;
  } finally {
    $('loading').classList.remove('on');
  }
}

// ---------- persistence ----------
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
  }, 400);
}
function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Object.assign(emptyState(), data);
  } catch { return null; }
}

// Restore UI from saved state.
$('trackName').value = state.name;
$('preset').value = state.preset;
$('width').value = state.widthM;
$('widthVal').textContent = `${state.widthM} m`;
if (state.points.length) map.on('load', flyToTrack);

// ---------- debug helpers (used by automated tests) ----------
window.__app = {
  map, editor, state,
  // Drop a demo circuit around the current map center (or given lng/lat).
  demoTrack(center) {
    const c = center || map.getCenter().toArray();
    const kx = 111320 * Math.cos((c[1] * Math.PI) / 180);
    const ky = 110574;
    const pts = [
      [0, 0], [620, -40], [980, 160], [1050, 420], [820, 560],
      [560, 480], [430, 620], [520, 850], [300, 980], [20, 900],
      [-160, 660], [-80, 400], [-220, 220], [-120, 60],
    ].map(([x, y]) => [c[0] + x / kx, c[1] + y / ky]);
    state.points = pts;
    state.closed = true;
    state.startS = 0.02;
    state.pit = [
      [0, -30], [200, -55], [420, -55], [600, -30],
    ].map(([x, y]) => [c[0] + x / kx, c[1] + y / ky]);
    editor.rebuild();
    flyToTrack();
  },
  enterDrive,
};
