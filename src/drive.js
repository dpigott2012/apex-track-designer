// First-person drive mode: builds a Three.js scene from the designed track.
import * as THREE from 'three';
import {
  offsetPath, fetchSatCanvas, bboxOfLngLats, fmtTime,
  makeElevationSampler, standPose,
} from './geo.js';

const UP = new THREE.Vector3(0, 1, 0);

// local meters [x east, y north] -> three.js (x east, z = -north)
const v3 = (p, y = 0) => new THREE.Vector3(p[0], y, -p[1]);

function asphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#37373c'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.25)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  // white edge lines (U axis spans track width)
  g.fillStyle = '#e9e9ef';
  g.fillRect(0, 0, 7, 256);
  g.fillRect(249, 0, 7, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function kerbTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#d32f2f'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#f5f5f5'; g.fillRect(0, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) {
    g.fillStyle = (x + y) % 2 ? '#111' : '#eee';
    g.fillRect(x * 8, y * 8, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Build a triangle-strip ribbon mesh between two offset polylines.
// elev (optional) is a per-sample height array applied to both edges.
function stripGeometry(left, right, s, vScale = 8, elev = null) {
  const n = left.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const y = elev ? elev[i] : 0;
    pos.set([left[i][0], y, -left[i][1]], i * 6);
    pos.set([right[i][0], y, -right[i][1]], i * 6 + 3);
    uv.set([0, s[i] / vScale], i * 4);
    uv.set([1, s[i] / vScale], i * 4 + 2);
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function closeLoopArrays(spline, metrics, arrs) {
  // Append first sample at the end so strips close the loop seamlessly.
  const out = {};
  out.pts = spline.pts.concat([spline.pts[0]]);
  out.s = spline.s.concat([spline.len]);
  out.heading = metrics.heading.concat([metrics.heading[0]]);
  out.curv = metrics.curv.concat([metrics.curv[0]]);
  return out;
}

export async function startDrive({ state, derived, container, hud, onExit }) {
  const { spline, metrics, proj, corners, startS0 } = derived;
  const width = state.widthM;
  const loop = closeLoopArrays(spline, metrics, []);
  const n = spline.pts.length;
  const L = spline.len;

  // ---------- terrain elevation (best effort — flat on failure) ----------
  let elevArr = new Array(n).fill(0);
  let groundElevAt = null; // (localPt) -> meters relative to track base
  try {
    const coordsLL = spline.pts.map(proj.toLngLat);
    const dem = await makeElevationSampler(bboxOfLngLats(coordsLL, 800), proj);
    let raw = spline.pts.map((p) => dem.elevAt(p));
    // Smooth twice (~±5 samples ≈ 40 m window) so the road stays drivable.
    for (let pass = 0; pass < 2; pass++) {
      const sm = raw.slice();
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = -5; j <= 5; j++) sum += raw[((i + j) % n + n) % n];
        sm[i] = sum / 11;
      }
      raw = sm;
    }
    const base = Math.min(...raw);
    elevArr = raw.map((e) => e - base);
    groundElevAt = (p) => dem.elevAt(p) - base;
    console.log(`elevation: ${Math.round(Math.max(...elevArr))}m of relief on this circuit`);
  } catch (e) { console.warn('elevation unavailable, driving flat', e); }
  const elevLoop = elevArr.concat([elevArr[0]]);

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ canvas: container, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa8c8e8);
  scene.fog = new THREE.Fog(0xa8c8e8, 600, 5000);
  const camera = new THREE.PerspectiveCamera(78, 1, 0.1, 9000);

  scene.add(new THREE.HemisphereLight(0xbfd9ee, 0x55624c, 1.0));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(400, 600, 250);
  scene.add(sun);

  // Road
  const fakeSpline = { pts: loop.pts, s: loop.s, len: L, closed: false };
  const fakeMetrics = { heading: loop.heading, curv: loop.curv };
  const left = offsetPath(fakeSpline, fakeMetrics, width / 2);
  const right = offsetPath(fakeSpline, fakeMetrics, -width / 2);
  const roadTex = asphaltTexture();
  const road = new THREE.Mesh(
    stripGeometry(left, right, loop.s, 10, elevLoop),
    new THREE.MeshLambertMaterial({ map: roadTex })
  );
  road.position.y = 0.05;
  scene.add(road);

  // Kerbs on corner regions (both sides).
  const kerbTex = kerbTexture();
  const kerbMat = new THREE.MeshLambertMaterial({ map: kerbTex });
  for (const c of corners) {
    const idxs = [];
    let i = (c.i0 - 4 + n) % n;
    const end = (c.i1 + 4) % n;
    for (let guard = 0; guard < n; guard++) {
      idxs.push(i);
      if (i === end) break;
      i = (i + 1) % n;
    }
    if (idxs.length < 2) continue;
    const sub = { pts: idxs.map((j) => spline.pts[j]), s: idxs.map((_, k) => k * 4), len: idxs.length * 4, closed: false };
    const subM = { heading: idxs.map((j) => metrics.heading[j]), curv: idxs.map((j) => metrics.curv[j]) };
    const subE = idxs.map((j) => elevArr[j]);
    for (const side of [1, -1]) {
      const a = offsetPath(sub, subM, side * (width / 2 + 0.1));
      const b = offsetPath(sub, subM, side * (width / 2 + 2.0));
      const kerb = new THREE.Mesh(stripGeometry(a, b, sub.s, 4, subE), kerbMat);
      kerb.position.y = 0.09;
      scene.add(kerb);
    }
  }

  // Start/finish: checker band + gantry.
  let si = 0;
  for (let i = 0; i < n; i++) if (spline.s[i] >= startS0) { si = i; break; }
  const sPos = spline.pts[si], sHead = metrics.heading[si], sElev = elevArr[si];
  {
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 2.4),
      new THREE.MeshLambertMaterial({ map: checkerTexture() })
    );
    band.rotation.x = -Math.PI / 2;
    band.rotation.z = -(sHead - Math.PI / 2);
    band.position.copy(v3(sPos, sElev + 0.12));
    scene.add(band);

    const postGeo = new THREE.CylinderGeometry(0.35, 0.35, 9, 8);
    const beamGeo = new THREE.BoxGeometry(width + 4, 1.4, 1.4);
    const grey = new THREE.MeshLambertMaterial({ color: 0x9aa0ad });
    const nx = -Math.sin(sHead), ny = Math.cos(sHead);
    for (const side of [1, -1]) {
      const post = new THREE.Mesh(postGeo, grey);
      post.position.copy(v3([sPos[0] + nx * side * (width / 2 + 1.5), sPos[1] + ny * side * (width / 2 + 1.5)], sElev + 4.5));
      scene.add(post);
    }
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshLambertMaterial({ color: 0xe10600 }));
    beam.position.copy(v3(sPos, sElev + 9));
    beam.rotation.y = -(sHead - Math.PI / 2) + Math.PI / 2;
    scene.add(beam);
  }

  // Grandstands.
  const standMat = new THREE.MeshLambertMaterial({ color: 0x7d8597 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xe10600 });
  for (const st of state.stands) {
    if (st.t == null) continue;
    const pose = standPose(spline, metrics, st);
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(64, 10, 20), standMat);
    base.position.y = 5;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(64, 0.8, 22), roofMat);
    roof.position.y = 13;
    g.add(base, roof);
    const sy = groundElevAt ? groundElevAt([pose.x, pose.y]) : elevArr[pose.i];
    g.position.copy(v3([pose.x, pose.y], sy));
    g.rotation.y = -(pose.angle - Math.PI / 2) + Math.PI / 2;
    scene.add(g);
  }

  // Ground: terrain-displaced mesh, draped with satellite imagery when it
  // loads. A flat apron is carved around the road — sized so that no terrain
  // triangle can start at road level and rise across the ribbon — then the
  // surface ramps out to true terrain height (like a real cutting).
  const CELL = 40; // spatial hash of road samples for fast nearest lookup
  const sampleGrid = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(spline.pts[i][0] / CELL)}_${Math.floor(spline.pts[i][1] / CELL)}`;
    if (!sampleGrid.has(k)) sampleGrid.set(k, []);
    sampleGrid.get(k).push(i);
  }
  // Nearest road sample, plus the LOWEST road elevation within minRadius —
  // where two track sections run close together the apron must duck under
  // both, not flatten to whichever is nearer.
  const nearestRoad = (ex, ny, minRadius = 0) => {
    let bi = -1, bd = Infinity, minElev = Infinity;
    const mr2 = minRadius * minRadius;
    const gx = Math.floor(ex / CELL), gy = Math.floor(ny / CELL);
    const minRings = Math.ceil(minRadius / CELL) + 1;
    for (let ring = 1; ring <= 6; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (ring > 1 && Math.max(Math.abs(dx), Math.abs(dy)) < ring) continue;
          const cell = sampleGrid.get(`${gx + dx}_${gy + dy}`);
          if (!cell) continue;
          for (const i of cell) {
            const p = spline.pts[i];
            const dd = (p[0] - ex) ** 2 + (p[1] - ny) ** 2;
            if (dd < bd) { bd = dd; bi = i; }
            if (dd < mr2 && elevArr[i] < minElev) minElev = elevArr[i];
          }
        }
      }
      if (bi >= 0 && ring >= minRings) break;
    }
    if (bi < 0) { // far from any sample — coarse fallback
      for (let i = 0; i < n; i += 16) {
        const p = spline.pts[i];
        const dd = (p[0] - ex) ** 2 + (p[1] - ny) ** 2;
        if (dd < bd) { bd = dd; bi = i; }
      }
    }
    if (minElev === Infinity) minElev = elevArr[bi];
    return { bi, dist: Math.sqrt(bd), minElev };
  };

  const makeTerrain = (w, h, cx, cy, mat) => {
    const seg = 240;
    const geo = new THREE.PlaneGeometry(w, h, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    if (groundElevAt) {
      const spacing = Math.max(w, h) / seg;
      const flatR = width / 2 + 2.5 + spacing; // road + kerbs + one vertex ring
      const rampLen = 45;
      for (let vi = 0; vi < pos.count; vi++) {
        const ex = cx + pos.getX(vi);          // east
        const ny = cy - pos.getZ(vi);          // north
        const { dist, minElev } = nearestRoad(ex, ny, flatR + spacing + 4);
        let t = Math.min(1, Math.max(0, (dist - flatR) / rampLen));
        t = t * t * (3 - 2 * t);
        pos.setY(vi, (1 - t) * (minElev - 0.3) + t * groundElevAt([ex, ny]));
      }
      geo.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, groundElevAt ? 0 : -0.08, -cy);
    return mesh;
  };

  const tb = bboxOfLngLats(spline.pts.map(proj.toLngLat), 800);
  const tA = proj.toLocal([tb.west, tb.north]);
  const tB = proj.toLocal([tb.east, tb.south]);
  let ground = makeTerrain(
    tB[0] - tA[0], tA[1] - tB[1],
    (tA[0] + tB[0]) / 2, (tA[1] + tB[1]) / 2,
    new THREE.MeshLambertMaterial({ color: 0x4a5d3a })
  );
  scene.add(ground);
  (async () => {
    try {
      const coords = spline.pts.map(proj.toLngLat);
      const sat = await fetchSatCanvas(bboxOfLngLats(coords, 500), 64);
      const tex = new THREE.CanvasTexture(sat.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const a = proj.toLocal([sat.west, sat.north]);
      const b = proj.toLocal([sat.east, sat.south]);
      const satGround = makeTerrain(
        b[0] - a[0], a[1] - b[1],
        (a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
        new THREE.MeshLambertMaterial({ map: tex })
      );
      scene.remove(ground);
      ground.geometry.dispose();
      ground = satGround;
      scene.add(ground);
    } catch (e) { console.warn('satellite ground failed', e); }
  })();

  // ---------- car state ----------
  const car = {
    x: 0, y: 0, heading: 0, v: 0, steer: 0,
    idx: si, elev: elevArr[si],
  };
  // Spawn ~15 m before the line.
  {
    let back = si;
    let dist = 0;
    while (dist < 15) {
      const prev = (back - 1 + n) % n;
      dist += ((spline.s[back] - spline.s[prev]) + L) % L;
      back = prev;
    }
    car.x = spline.pts[back][0];
    car.y = spline.pts[back][1];
    car.heading = metrics.heading[back];
    car.idx = back;
  }

  const keys = {};
  const onKey = (down) => (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    keys[k] = down;
    if (down && k === 'escape') stop();
    if (down && k === 'r') respawn();
  };
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);

  function respawn() {
    const i = car.idx;
    car.x = spline.pts[i][0]; car.y = spline.pts[i][1];
    car.heading = metrics.heading[i]; car.v = 0;
    car.elev = elevArr[i];
  }

  let flashMsg = '', flashT = 0;

  // Lap timing
  let lapStart = null, lastLap = null, bestLap = null, lapCount = 0;
  let prevProg = null;

  // Minimap
  const mini = hud.minimap.getContext('2d');
  const MM = hud.minimap.width;
  let mmBounds;
  {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of spline.pts) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    const sc = (MM - 24) / Math.max(x1 - x0, y1 - y0);
    mmBounds = { x0, y0, sc, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  const mmPt = (p) => [
    MM / 2 + (p[0] - mmBounds.cx) * mmBounds.sc,
    MM / 2 - (p[1] - mmBounds.cy) * mmBounds.sc,
  ];

  function resize() {
    const w = container.clientWidth || innerWidth;
    const h = container.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let raf = 0, last = performance.now(), running = true;
  let offTrack = false, wrongWayT = 0;

  // Debug handle for scripted testing (see CLAUDE.md).
  window.__drive = { scene, car, elevArr, spline, width, getGround: () => ground };

  function physics(dt) {
    const throttle = keys['w'] || keys['arrowup'] ? 1 : 0;
    const brake = keys['s'] || keys['arrowdown'] ? 1 : 0;
    const sL = keys['a'] || keys['arrowleft'] ? 1 : 0;
    const sR = keys['d'] || keys['arrowright'] ? 1 : 0;

    const VMAX = 92, WHEELBASE = 3.4;
    const grip = offTrack ? 0.35 : 1;

    // Longitudinal
    let a = 0;
    if (throttle) a += 13 * Math.max(0.15, 1 - car.v / VMAX) * grip;
    if (brake) {
      if (car.v > 0.5) a -= 40 * grip;
      else { car.v = Math.max(car.v - 8 * dt, -11); a = 0; }
    }
    a -= 0.0022 * car.v * car.v;          // aero drag
    if (offTrack) a -= 0.03 * car.v * Math.abs(car.v) * 0.4 + 2; // grass drag
    if (!throttle && !brake) a -= 1.2 * Math.sign(car.v);
    car.v += a * dt;
    if (!throttle && !brake && Math.abs(car.v) < 0.6) car.v = 0;

    // Steering: less lock at speed, lateral-g cap.
    const target = (sL - sR) * 0.42 / (1 + Math.pow(Math.abs(car.v) / 22, 1.35));
    car.steer += (target - car.steer) * Math.min(1, dt * 10);
    let yawRate = (car.v / WHEELBASE) * Math.tan(car.steer);
    const aLatMax = (offTrack ? 9 : 36);
    const maxYaw = Math.abs(car.v) > 0.5 ? aLatMax / Math.abs(car.v) : 10;
    yawRate = Math.max(-maxYaw, Math.min(maxYaw, yawRate));
    car.heading += yawRate * dt;

    car.x += Math.cos(car.heading) * car.v * dt;
    car.y += Math.sin(car.heading) * car.v * dt;

    // Nearest sample (windowed search around last index).
    let best = car.idx, bestD = Infinity;
    for (let j = -50; j <= 50; j++) {
      const i = ((car.idx + j) % n + n) % n;
      const p = spline.pts[i];
      const dd = (p[0] - car.x) ** 2 + (p[1] - car.y) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    car.idx = best;
    const offDist = Math.sqrt(bestD);
    offTrack = offDist > width / 2 + 1.2;

    // Too far gone — bring the car back so the driver never gets lost.
    if (offDist > 60) {
      respawn();
      flashMsg = 'RESET TO TRACK'; flashT = 2.5;
    }

    // Gravity along the road gradient (on track only).
    if (!offTrack && Math.abs(car.v) > 0.5) {
      const i2 = (best + 3) % n, i0 = ((best - 3) % n + n) % n;
      const dss = ((spline.s[i2] - spline.s[i0]) + L) % L || 1;
      const grade = (elevArr[i2] - elevArr[i0]) / dss;
      const align = Math.cos(car.heading - metrics.heading[best]);
      car.v -= 9.81 * grade * align * dt;
    }

    // Follow road height on track; on grass blend from the flat apron out to
    // true terrain height, matching the ground mesh around the road.
    let targetElev = elevArr[best];
    if (offTrack && groundElevAt) {
      let t = Math.min(1, Math.max(0, (offDist - width / 2 - 18) / 45));
      t = t * t * (3 - 2 * t);
      targetElev = (1 - t) * elevArr[best] + t * groundElevAt([car.x, car.y]);
    }
    car.elev += (targetElev - car.elev) * Math.min(1, dt * 7);
    if (flashT > 0) flashT -= dt;

    // Lap progress / timing.
    const prog = ((spline.s[best] - startS0) + L) % L;
    if (prevProg != null) {
      let d = prog - prevProg;
      if (d < -L / 2) d += L;       // crossed the line forward
      if (d > L / 2) d -= L;        // crossed backward
      if (d < -0.5) wrongWayT += dt; else wrongWayT = 0;
      if (prevProg > L - 30 && prog < 30 && d > 0) {
        const now = performance.now();
        if (lapStart != null) {
          lastLap = (now - lapStart) / 1000;
          if (bestLap == null || lastLap < bestLap) bestLap = lastLap;
          lapCount++;
        }
        lapStart = now;
      }
    }
    prevProg = prog;
    return prog;
  }

  function updateHud(prog) {
    hud.speed.textContent = Math.round(Math.abs(car.v) * 3.6);
    hud.gear.textContent = car.v < -0.5 ? 'R' : Math.min(8, Math.max(1, 1 + Math.floor(Math.abs(car.v) / 12)));
    hud.time.textContent = lapStart ? fmtTime((performance.now() - lapStart) / 1000) : '--:--.---';
    hud.last.textContent = `LAST ${fmtTime(lastLap)}`;
    hud.best.textContent = `BEST ${fmtTime(bestLap)}`;
    hud.lap.textContent = `LAP ${lapCount + 1}`;

    // Upcoming corner callout.
    let next = null;
    for (const c of corners) {
      const d = ((c.sApex - startS0 + L) % L - prog + L) % L;
      if (d < 230 && (next == null || d < next.d)) next = { c, d };
    }
    if (next) {
      const nm = state.turnNames[next.c.n];
      hud.turn.textContent = `${next.c.dir === 'L' ? '◀' : '▶'} T${next.c.n}${nm ? ' · ' + nm : ''} — ${Math.round(next.d)}m`;
      hud.turn.style.opacity = 1;
    } else hud.turn.style.opacity = 0;

    hud.msg.textContent = flashT > 0 ? flashMsg
      : wrongWayT > 1.5 ? 'WRONG WAY'
      : offTrack ? 'OFF TRACK' : '';

    // Minimap
    mini.clearRect(0, 0, MM, MM);
    mini.strokeStyle = 'rgba(255,255,255,0.85)';
    mini.lineWidth = 2;
    mini.beginPath();
    spline.pts.forEach((p, i) => {
      const q = mmPt(p);
      i ? mini.lineTo(q[0], q[1]) : mini.moveTo(q[0], q[1]);
    });
    mini.closePath();
    mini.stroke();
    const sq = mmPt(sPos);
    mini.fillStyle = '#fff';
    mini.fillRect(sq[0] - 2.5, sq[1] - 2.5, 5, 5);
    const cq = mmPt([car.x, car.y]);
    mini.fillStyle = '#e10600';
    mini.beginPath();
    mini.arc(cq[0], cq[1], 4, 0, Math.PI * 2);
    mini.fill();
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.033, (now - last) / 1000) || 0.016;
    last = now;
    const prog = physics(dt);

    // First-person camera.
    const shake = offTrack && Math.abs(car.v) > 3 ? 0.06 : 0;
    camera.position.set(
      car.x + (Math.random() - 0.5) * shake,
      car.elev + 1.05 + (Math.random() - 0.5) * shake,
      -(car.y + (Math.random() - 0.5) * shake)
    );
    const aheadElev = offTrack ? car.elev : elevArr[(car.idx + 5) % n];
    const look = v3(
      [car.x + Math.cos(car.heading) * 20, car.y + Math.sin(car.heading) * 20],
      aheadElev + 0.9
    );
    camera.lookAt(look);
    camera.fov = 76 + Math.abs(car.v) * 0.22;
    camera.updateProjectionMatrix();

    updateHud(prog);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', kd);
    window.removeEventListener('keyup', ku);
    window.removeEventListener('resize', resize);
    renderer.dispose();
    delete window.__drive;
    onExit();
  }
  return { stop };
}
