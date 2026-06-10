// Geometry & geo math: projection, splines, curvature, corners, lap sim, tiles.

const DEG = Math.PI / 180;

// Local equirectangular projection (meters) around an origin. Accurate enough
// at track scale (< ~20 km). x = east, y = north.
export function makeProjection(origin) {
  const kx = 111320 * Math.cos(origin.lat * DEG);
  const ky = 110574;
  return {
    origin,
    toLocal: (ll) => [(ll[0] - origin.lng) * kx, (ll[1] - origin.lat) * ky],
    toLngLat: (p) => [origin.lng + p[0] / kx, origin.lat + p[1] / ky],
  };
}

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

// Catmull-Rom sample of control points (local meters). Returns evenly-ish
// spaced samples (~step meters apart) with cumulative arc length.
export function sampleSpline(ctrl, closed, step = 4) {
  const n = ctrl.length;
  if (n < 2) return { pts: [], s: [], len: 0, closed };
  const get = (i) => ctrl[((i % n) + n) % n];
  const pts = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p1 = get(i), p2 = get(i + 1);
    const p0 = closed ? get(i - 1) : ctrl[Math.max(0, i - 1)];
    const p3 = closed ? get(i + 2) : ctrl[Math.min(n - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(4, Math.ceil(segLen / step));
    for (let j = 0; j < steps; j++) pts.push(cr(p0, p1, p2, p3, j / steps));
  }
  if (!closed) pts.push([ctrl[n - 1][0], ctrl[n - 1][1]]);
  const s = new Array(pts.length);
  s[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  let len = s[pts.length - 1];
  if (closed) len += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return { pts, s, len, closed };
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Heading + smoothed signed curvature (1/m, + = left) at each sample.
export function pathMetrics(spline, smoothMeters = 16) {
  const { pts, s, len, closed } = spline;
  const n = pts.length;
  const heading = new Array(n), curv = new Array(n);
  if (n < 3) return { heading: heading.fill(0), curv: curv.fill(0) };
  const idx = (i) => closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i));
  for (let i = 0; i < n; i++) {
    const a = pts[idx(i - 1)], b = pts[idx(i + 1)];
    heading[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = idx(i - 1), i1 = idx(i + 1);
    let ds = (closed ? (s[i1] - s[i0] + len) % len : s[i1] - s[i0]);
    if (ds < 0.1) ds = 0.1;
    raw[i] = angDiff(heading[i1], heading[i0]) / ds;
  }
  const avgDs = len / n;
  const w = Math.max(1, Math.round(smoothMeters / avgDs / 2));
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = -w; j <= w; j++) {
      const k = closed ? idx(i + j) : i + j;
      if (k < 0 || k >= n) continue;
      sum += raw[k]; cnt++;
    }
    curv[i] = sum / cnt;
  }
  return { heading, curv };
}

// Offset each sample to the left (d > 0) of travel direction.
export function offsetPath(spline, metrics, d) {
  return spline.pts.map((p, i) => [
    p[0] - Math.sin(metrics.heading[i]) * d,
    p[1] + Math.cos(metrics.heading[i]) * d,
  ]);
}

// Closed ring polygon for the track ribbon (local meters).
export function ribbonRing(spline, metrics, width) {
  const left = offsetPath(spline, metrics, width / 2);
  const right = offsetPath(spline, metrics, -width / 2);
  if (spline.closed) {
    left.push(left[0]);
    right.push(right[0]);
  }
  return left.concat(right.reverse());
}

// Detect corner regions from curvature. Returns array of
// {i0, i1, iApex, sApex, dir ('L'|'R'), radius, totalAngle}.
export function detectCorners(spline, metrics, minRadius = 250, mergeGap = 30, minAngle = 0.16) {
  const { pts, s, len, closed } = spline;
  const n = pts.length;
  const k = metrics.curv;
  const thresh = 1 / minRadius;
  if (n < 10) return [];
  const over = new Array(n);
  for (let i = 0; i < n; i++) over[i] = Math.abs(k[i]) > thresh;

  // Build contiguous regions (with wrap for closed tracks).
  const regions = [];
  let start = -1;
  const N = closed ? n + 1 : n;
  for (let ii = 0; ii < N; ii++) {
    const i = ii % n;
    if (over[i] && start < 0) start = ii;
    if ((!over[i] || ii === N - 1) && start >= 0) {
      regions.push([start, over[i] && ii === N - 1 ? ii : ii - 1]);
      start = -1;
    }
  }
  if (closed && regions.length >= 2) {
    const first = regions[0], last = regions[regions.length - 1];
    if (first[0] === 0 && last[1] % n === n - 1) {
      regions.pop();
      regions[0] = [last[0] - n, first[1]]; // merged wrap region (negative start ok)
    }
  }
  // Merge regions separated by small gaps.
  const merged = [];
  for (const r of regions) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = ((s[((r[0] % n) + n) % n] - s[((prev[1] % n) + n) % n]) + len) % len;
      if (gap < mergeGap) { prev[1] = r[1]; continue; }
    }
    merged.push([r[0], r[1]]);
  }
  const corners = [];
  for (const [a, b] of merged) {
    let iApex = a, maxK = 0, total = 0;
    for (let ii = a; ii <= b; ii++) {
      const i = ((ii % n) + n) % n;
      const ds = ii > a ? ((s[i] - s[((ii - 1) % n + n) % n] + len) % len) : 0;
      total += k[i] * ds;
      if (Math.abs(k[i]) > maxK) { maxK = Math.abs(k[i]); iApex = i; }
    }
    if (Math.abs(total) < minAngle) continue;
    corners.push({
      i0: ((a % n) + n) % n, i1: ((b % n) + n) % n, iApex,
      sApex: s[iApex], dir: total > 0 ? 'L' : 'R',
      radius: Math.round(1 / Math.max(maxK, 1e-6)),
      totalAngle: total,
    });
  }
  return corners;
}

// Longest run with near-zero curvature ("straight"), in meters.
export function longestStraight(spline, metrics, maxCurv = 1 / 800) {
  const { s, len, closed, pts } = spline;
  const n = pts.length;
  let best = 0, runStart = -1;
  const N = closed ? 2 * n : n;
  for (let ii = 0; ii < N; ii++) {
    const i = ii % n;
    if (Math.abs(metrics.curv[i]) < maxCurv) {
      if (runStart < 0) runStart = ii;
      const d = closed ? Math.min((s[i] - s[runStart % n] + len) % len, len) : s[i] - s[runStart % n];
      if (d > best) best = d;
    } else runStart = -1;
    if (best >= len) return len;
  }
  return best;
}

// Quasi-static lap time: corner-limited speed profile with accel/brake passes.
export function estimateLap(spline, metrics, car = { vMax: 92, aLat: 30, aBrake: 39, aAccel: 12.5 }) {
  const { s, len, closed } = spline;
  const n = spline.pts.length;
  if (n < 10 || !closed || len < 100) return null;
  const vLim = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(metrics.curv[i]);
    vLim[i] = Math.min(car.vMax, Math.sqrt(car.aLat / Math.max(k, 1e-9)));
  }
  const v = vLim.slice();
  const ds = (i) => ((s[(i + 1) % n] - s[i]) + len) % len || len / n;
  // Forward (acceleration) — two loops so the start condition converges.
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = car.aAccel * Math.max(0.15, 1 - v[i] / car.vMax);
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * a * ds(i)));
    }
  }
  // Backward (braking).
  for (let lap = 0; lap < 2; lap++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * car.aBrake * ds(i)));
    }
  }
  let t = 0, vTop = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const va = Math.max(1, (v[i] + v[j]) / 2);
    t += ds(i) / va;
    if (v[i] > vTop) vTop = v[i];
  }
  return { time: t, vTop, profile: v };
}

// ---- Satellite tile stitching (Esri World Imagery) ----

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

function lng2tile(lng, z) { return ((lng + 180) / 360) * Math.pow(2, z); }
function lat2tile(lat, z) {
  const r = lat * DEG;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}
function tile2lng(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
function tile2lat(y, z) {
  const m = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// Stitch satellite tiles covering a lng/lat bbox into one canvas.
// Returns {canvas, west, south, east, north} or null on failure.
export async function fetchSatCanvas(bbox, maxTiles = 64) {
  let z = 18, x0, x1, y0, y1;
  for (; z > 4; z--) {
    x0 = Math.floor(lng2tile(bbox.west, z)); x1 = Math.floor(lng2tile(bbox.east, z));
    y0 = Math.floor(lat2tile(bbox.north, z)); y1 = Math.floor(lat2tile(bbox.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) break;
  }
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx * 256; canvas.height = ny * 256;
  const ctx = canvas.getContext('2d');
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(loadImage(TILE_URL(z, x, y)).then(
        (img) => ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256),
        () => {}
      ));
    }
  }
  await Promise.all(jobs);
  return {
    canvas,
    west: tile2lng(x0, z), east: tile2lng(x1 + 1, z),
    north: tile2lat(y0, z), south: tile2lat(y1 + 1, z),
  };
}

export function bboxOfLngLats(coords, marginM = 0) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const c of coords) {
    if (c[0] < west) west = c[0];
    if (c[0] > east) east = c[0];
    if (c[1] < south) south = c[1];
    if (c[1] > north) north = c[1];
  }
  const latM = marginM / 110574;
  const lngM = marginM / (111320 * Math.cos(((south + north) / 2) * DEG));
  return { west: west - lngM, east: east + lngM, south: south - latM, north: north + latM };
}

export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`;
}

export function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${Math.round(m)} m`;
}
