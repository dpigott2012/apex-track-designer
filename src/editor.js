// Track editor: owns map layers, drawing interactions, and derived geometry.
import {
  makeProjection, sampleSpline, pathMetrics, offsetPath, ribbonRing,
  detectCorners, longestStraight, estimateLap, standPose,
} from './geo.js';
import { PRESETS } from './validate.js';

const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const PIT_WIDTH = 11;

export function emptyState() {
  return {
    name: 'Untitled Circuit',
    points: [],          // [lng, lat] control points
    closed: false,
    widthM: 13,
    pit: [],             // [lng, lat] pit lane polyline
    startS: 0,           // start/finish position as fraction of lap
    stands: [],          // {t: lap fraction, offset: signed lateral meters}
    turnNames: {},       // turnNumber -> custom name
    preset: 'f1',
  };
}

export function createMap(container) {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      projection: { type: 'globe' },
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        sat: {
          type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
        dem: {
          type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256,
          encoding: 'terrarium', maxzoom: 13,
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a0e1a' } },
        { id: 'sat', type: 'raster', source: 'sat' },
      ],
      sky: {
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 7, 0.3, 10, 0],
      },
    },
    center: [-30, 25], zoom: 1.6, maxPitch: 75,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
  // The browser context menu would cover the map and eat right-click deletes.
  map.getCanvasContainer().addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Globe is gorgeous zoomed out, but MapLibre 5 can't draw circle/symbol
  // layers with terrain on the globe projection. Past city scale the two
  // projections look identical, so swap to mercator+terrain when zoomed in.
  let near = false;
  const updateProjection = () => {
    if (map.isMoving()) return; // never swap projection mid-animation — it stalls the camera
    const z = map.getZoom();
    if (z >= 9 && !near) {
      near = true;
      map.setProjection({ type: 'mercator' });
      try { map.setTerrain({ source: 'dem', exaggeration: 1.0 }); } catch (e) { console.warn('terrain', e); }
    } else if (z < 8.5 && near) {
      near = false;
      map.setTerrain(null);
      map.setProjection({ type: 'globe' });
    }
  };
  map.on('load', updateProjection);
  map.on('moveend', updateProjection);
  map.on('zoomend', updateProjection);
  return map;
}

export class TrackEditor {
  constructor(map, state, onChange) {
    this.map = map;
    this.state = state;
    this.onChange = onChange;
    this.mode = 'view';
    this.derived = null;
    this.drag = null;
    this._rebuildTimer = null;
    map.on('load', () => { this._addLayers(); this.rebuild(); });
    this._bindEvents();
  }

  setMode(mode) {
    this.mode = mode;
    this.map.getCanvas().style.cursor =
      mode === 'view' ? '' : 'crosshair';
  }

  _addLayers() {
    const map = this.map;
    const empty = { type: 'FeatureCollection', features: [] };
    const srcs = ['track-ribbon', 'pit-ribbon', 'centerline', 'ctrl-points',
      'pit-points', 'start-line', 'turn-labels', 'stands'];
    for (const id of srcs) map.addSource(id, { type: 'geojson', data: empty });

    map.addLayer({ id: 'stands-fill', type: 'fill-extrusion', source: 'stands',
      paint: { 'fill-extrusion-color': '#8c93a8', 'fill-extrusion-height': 14, 'fill-extrusion-opacity': 0.95 } });
    map.addLayer({ id: 'pit-fill', type: 'fill', source: 'pit-ribbon',
      paint: { 'fill-color': '#3d4f6b', 'fill-opacity': 0.9 } });
    map.addLayer({ id: 'track-fill', type: 'fill', source: 'track-ribbon',
      paint: { 'fill-color': '#2b2b30', 'fill-opacity': 0.92 } });
    map.addLayer({ id: 'track-edge', type: 'line', source: 'track-ribbon',
      paint: { 'line-color': '#e8e8ee', 'line-width': 1.4 } });
    map.addLayer({ id: 'centerline-l', type: 'line', source: 'centerline',
      paint: { 'line-color': '#ffd24d', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } });
    map.addLayer({ id: 'start-line-l', type: 'line', source: 'start-line',
      paint: { 'line-color': '#ffffff', 'line-width': 5 } });
    map.addLayer({ id: 'ctrl-points-l', type: 'circle', source: 'ctrl-points',
      paint: {
        'circle-radius': ['case', ['get', 'first'], 8, 6],
        'circle-color': ['case', ['get', 'first'], '#e10600', '#ffd24d'],
        'circle-stroke-width': 2, 'circle-stroke-color': '#111',
      } });
    map.addLayer({ id: 'pit-points-l', type: 'circle', source: 'pit-points',
      paint: { 'circle-radius': 5, 'circle-color': '#69a8ff', 'circle-stroke-width': 2, 'circle-stroke-color': '#111' } });
    map.addLayer({ id: 'turn-labels-l', type: 'symbol', source: 'turn-labels',
      layout: {
        'text-field': ['get', 'label'], 'text-size': 13,
        'text-font': ['Noto Sans Regular'], 'text-offset': [0, -1.2],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 } });
  }

  _bindEvents() {
    const map = this.map;
    map.on('click', (e) => this._onClick(e));
    map.on('mousedown', (e) => this._onMouseDown(e));
    map.on('mousemove', (e) => this._onMouseMove(e));
    map.on('mouseup', () => this._onMouseUp());
    map.on('contextmenu', (e) => this._onRightClick(e));
  }

  _onClick(e) {
    const s = this.state;
    const ll = [e.lngLat.lng, e.lngLat.lat];
    // Alt+click deletes — same as right-click, for trackpads/missing buttons.
    if (e.originalEvent && e.originalEvent.altKey) {
      this._deleteAt(e.point);
      return;
    }
    if (this.mode === 'track') {
      if (s.closed) {
        // Closed loop: clicking near the track inserts a point into the
        // nearest segment so new corners can be pulled out afterward.
        this._insertPoint(ll);
        return;
      }
      // Clicking the first point with >= 3 points closes the loop.
      if (s.points.length >= 3) {
        const p0 = this.map.project(s.points[0]);
        if (Math.hypot(p0.x - e.point.x, p0.y - e.point.y) < 14) {
          this.closeLoop();
          return;
        }
      }
      s.points.push(ll);
      this.rebuild();
    } else if (this.mode === 'pit') {
      s.pit.push(this._snapToTrackEdge(ll));
      this.rebuild();
    } else if (this.mode === 'start') {
      this._setStart(ll);
    } else if (this.mode === 'stand') {
      this._addStand(ll);
    }
  }

  _featureAt(point, layers) {
    const f = this.map.queryRenderedFeatures(point, { layers });
    return f && f.length ? f[0] : null;
  }

  _onMouseDown(e) {
    const f = this._featureAt(e.point, ['ctrl-points-l', 'pit-points-l']);
    if (!f) return;
    e.preventDefault();
    this.drag = { kind: f.properties.kind, idx: f.properties.idx };
    this.map.dragPan.disable();
  }

  _onMouseMove(e) {
    if (!this.drag) {
      const f = this._featureAt(e.point, ['ctrl-points-l', 'pit-points-l', 'stands-fill']);
      this.map.getCanvas().style.cursor = f
        ? (f.properties.kind === 'stand' ? 'pointer' : 'move')
        : (this.mode === 'view' ? '' : 'crosshair');
      return;
    }
    const ll = [e.lngLat.lng, e.lngLat.lat];
    if (this.drag.kind === 'track') this.state.points[this.drag.idx] = ll;
    else this.state.pit[this.drag.idx] = ll;
    this.rebuildSoon();
  }

  _onMouseUp() {
    if (!this.drag) return;
    this.drag = null;
    this.map.dragPan.enable();
    this.rebuild();
  }

  _onRightClick(e) {
    if (this._deleteAt(e.point)) {
      e.preventDefault();
      if (e.originalEvent) e.originalEvent.preventDefault();
    }
  }

  _deleteAt(point) {
    const f = this._featureAt(point, ['ctrl-points-l', 'pit-points-l', 'stands-fill']);
    if (!f) return false;
    const s = this.state;
    if (f.properties.kind === 'track') {
      s.points.splice(f.properties.idx, 1);
      if (s.points.length < 3) s.closed = false;
    } else if (f.properties.kind === 'stand') {
      s.stands.splice(f.properties.idx, 1);
    } else {
      s.pit.splice(f.properties.idx, 1);
    }
    this.rebuild();
    return true;
  }

  closeLoop() {
    if (this.state.points.length >= 3) {
      this.state.closed = true;
      this.rebuild();
    }
  }

  undo() {
    const s = this.state;
    if (this.mode === 'pit' && s.pit.length) s.pit.pop();
    else if (s.closed) s.closed = false;
    else if (s.points.length) s.points.pop();
    this.rebuild();
  }

  clearAll() {
    Object.assign(this.state, emptyState(), { preset: this.state.preset });
    this.rebuild();
  }

  // Nearest spline sample to a local point: {i, dist, side (+1 left of travel)}.
  _nearest(p) {
    const d = this.derived;
    return d ? this._nearestOn(d.spline, d.metrics, p) : null;
  }

  _setStart(ll) {
    const d = this.derived;
    if (!d || !this.state.closed) return;
    const near = this._nearest(d.proj.toLocal(ll));
    if (!near) return;
    this.state.startS = d.spline.s[near.i] / d.spline.len;
    this.rebuild();
  }

  // Insert a control point into the nearest segment of the closed loop.
  _insertPoint(ll) {
    const d = this.derived;
    const s = this.state;
    if (!d) return;
    const p = d.proj.toLocal(ll);
    const ctrl = s.points.map(d.proj.toLocal);
    const n = ctrl.length;
    let bestSeg = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const a = ctrl[i], b = ctrl[(i + 1) % n];
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
      const dx = p[0] - (a[0] + t * abx), dy = p[1] - (a[1] + t * aby);
      const dd = dx * dx + dy * dy;
      if (dd < bestD) { bestD = dd; bestSeg = i; }
    }
    if (bestSeg < 0 || Math.sqrt(bestD) > 150) return; // too far from the track
    s.points.splice(bestSeg + 1, 0, ll);
    this.rebuild();
  }

  // Snap pit-lane clicks near the circuit onto the track edge so the
  // pit lane visually attaches to the racing surface.
  _snapToTrackEdge(ll) {
    const d = this.derived;
    if (!d) return ll;
    const near = this._nearest(d.proj.toLocal(ll));
    if (!near || near.dist > this.state.widthM / 2 + 25) return ll;
    const h = d.metrics.heading[near.i];
    const q = d.spline.pts[near.i];
    const off = near.side * (this.state.widthM / 2);
    return d.proj.toLngLat([q[0] - Math.sin(h) * off, q[1] + Math.cos(h) * off]);
  }

  _addStand(ll) {
    const d = this.derived;
    if (!d) return; // stands are anchored to the track — need one first
    const near = this._nearest(d.proj.toLocal(ll));
    if (!near || near.dist > 400) return;
    const minOff = this.state.widthM / 2 + 16;
    this.state.stands.push({
      t: d.spline.s[near.i] / d.spline.len,
      offset: near.side * Math.max(near.dist, minOff),
    });
    this.rebuild();
  }

  rebuildSoon() {
    if (this._rebuildTimer) return;
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      this.rebuild();
    }, 40);
  }

  // Recompute all derived geometry and refresh map sources + side panel.
  rebuild() {
    const s = this.state;
    const map = this.map;
    if (!map.getSource('track-ribbon')) {
      // Layers not added yet — rebuild reruns from the constructor's load hook.
      return;
    }
    const setData = (id, features) =>
      map.getSource(id).setData({ type: 'FeatureCollection', features });

    if (s.points.length < 2) {
      this.derived = null;
      s.stands = []; // stands are track-anchored — no track, no stands
      for (const id of ['track-ribbon', 'centerline', 'start-line', 'turn-labels', 'stands'])
        setData(id, []);
      setData('ctrl-points', this._pointFeatures(s.points, 'track'));
      this._rebuildPit(setData, null);
      this.onChange(null);
      return;
    }

    const proj = makeProjection({ lng: s.points[0][0], lat: s.points[0][1] });
    const ctrl = s.points.map(proj.toLocal);
    const spline = sampleSpline(ctrl, s.closed, 4);
    const metrics = pathMetrics(spline);
    const startS0 = s.startS * spline.len;

    // Corners, numbered in driving order from the start line.
    let corners = s.closed ? detectCorners(spline, metrics) : [];
    corners = corners
      .map((c) => ({ ...c, sFromStart: ((c.sApex - startS0) + spline.len) % spline.len }))
      .sort((a, b) => a.sFromStart - b.sFromStart)
      .map((c, i) => ({ ...c, n: i + 1, name: s.turnNames[i + 1] || '' }));

    const straight = s.closed ? longestStraight(spline, metrics) : 0;
    const lap = s.closed ? estimateLap(spline, metrics, PRESETS[s.preset].car) : null;

    // Pit lane.
    const pitDerived = this._rebuildPit(setData, proj);

    const ring = ribbonRing(spline, metrics, s.widthM).map(proj.toLngLat);
    setData('track-ribbon', [{
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [ring.concat([ring[0]])] },
    }]);

    const center = spline.pts.map(proj.toLngLat);
    if (s.closed) center.push(center[0]);
    setData('centerline', [{
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: center },
    }]);

    setData('ctrl-points', this._pointFeatures(s.points, 'track'));

    // Start/finish line across the ribbon.
    if (s.closed) {
      let si = 0;
      for (let i = 0; i < spline.pts.length; i++) {
        if (spline.s[i] >= startS0) { si = i; break; }
      }
      const h = metrics.heading[si];
      const c = spline.pts[si];
      const w = s.widthM / 2 + 2;
      const a = proj.toLngLat([c[0] - Math.sin(h) * w, c[1] + Math.cos(h) * w]);
      const b = proj.toLngLat([c[0] + Math.sin(h) * w, c[1] - Math.cos(h) * w]);
      setData('start-line', [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [a, b] },
      }]);
    } else setData('start-line', []);

    setData('turn-labels', corners.map((c) => ({
      type: 'Feature',
      properties: { label: c.name ? `T${c.n} ${c.name}` : `T${c.n}` },
      geometry: { type: 'Point', coordinates: proj.toLngLat(spline.pts[c.iApex]) },
    })));

    this._rebuildStands(setData, proj, spline, metrics);

    const firstCornerDist = corners.length
      ? ((corners[0].i0 != null ? ((spline.s[corners[0].i0] - startS0) + spline.len) % spline.len : 0))
      : 0;

    this.derived = {
      proj, spline, metrics, corners, straight, lap,
      len: spline.len, width: s.widthM, closed: s.closed,
      pitLen: pitDerived ? pitDerived.len : 0,
      firstCornerDist,
      startS0,
    };
    this.onChange(this.derived);
  }

  _rebuildPit(setData, proj) {
    const s = this.state;
    setData('pit-points', this._pointFeatures(s.pit, 'pit'));
    if (!proj || s.pit.length < 2) { setData('pit-ribbon', []); return null; }
    const ctrl = s.pit.map(proj.toLocal);
    const spline = sampleSpline(ctrl, false, 4);
    const metrics = pathMetrics(spline);
    const ring = ribbonRing(spline, metrics, PIT_WIDTH).map(proj.toLngLat);
    setData('pit-ribbon', [{
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [ring.concat([ring[0]])] },
    }]);
    return { len: spline.len, spline, metrics };
  }

  _rebuildStands(setData, proj, spline, metrics) {
    const s = this.state;
    // Migrate legacy absolute stands ({lng, lat, angle}) to track anchors.
    s.stands = s.stands.filter((st) => {
      if (st.t != null) return true;
      if (!st.lng) return false;
      const near = this._nearestOn(spline, metrics, proj.toLocal([st.lng, st.lat]));
      if (!near || near.dist > 400) return false;
      st.t = spline.s[near.i] / spline.len;
      st.offset = near.side * Math.max(near.dist, s.widthM / 2 + 16);
      delete st.lng; delete st.lat; delete st.angle;
      return true;
    });
    if (!s.stands.length) { setData('stands', []); return; }
    const W = 64, D = 20; // meters
    setData('stands', s.stands.map((st) => {
      const pose = standPose(spline, metrics, st);
      const cos = Math.cos(pose.angle), sin = Math.sin(pose.angle);
      const corner = (dx, dy) => proj.toLngLat([
        pose.x + dx * cos - dy * sin,
        pose.y + dx * sin + dy * cos,
      ]);
      const ring = [
        corner(-W / 2, -D / 2), corner(W / 2, -D / 2),
        corner(W / 2, D / 2), corner(-W / 2, D / 2), corner(-W / 2, -D / 2),
      ];
      return {
        type: 'Feature', properties: { idx: s.stands.indexOf(st), kind: 'stand' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      };
    }));
  }

  _nearestOn(spline, metrics, p) {
    let best = 0, bestD = Infinity;
    spline.pts.forEach((q, i) => {
      const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (!spline.pts.length) return null;
    const h = metrics.heading[best];
    const q = spline.pts[best];
    const cross = Math.cos(h) * (p[1] - q[1]) - Math.sin(h) * (p[0] - q[0]);
    return { i: best, dist: Math.sqrt(bestD), side: cross >= 0 ? 1 : -1 };
  }

  _pointFeatures(coords, kind) {
    return coords.map((c, i) => ({
      type: 'Feature',
      properties: { idx: i, kind, first: kind === 'track' && i === 0 && !this.state.closed && coords.length >= 3 },
      geometry: { type: 'Point', coordinates: c },
    }));
  }
}
