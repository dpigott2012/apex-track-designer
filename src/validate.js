// Homologation presets & live checks (simplified from FIA Appendix O and
// common circuit-design guidance — directional, not official).

export const PRESETS = {
  f1: {
    label: 'F1 — FIA Grade 1',
    minLen: 3500, maxLen: 7000,
    minWidth: 12,
    maxStraight: 2000,
    pitRequired: true, minPitLen: 250,
    minFirstCornerDist: 250,
    car: { vMax: 95, aLat: 34, aBrake: 44, aAccel: 13.5 },
  },
  gt: {
    label: 'GT / FIA Grade 2',
    minLen: 3000, maxLen: 8000,
    minWidth: 10,
    maxStraight: 2000,
    pitRequired: true, minPitLen: 200,
    minFirstCornerDist: 200,
    car: { vMax: 83, aLat: 16, aBrake: 22, aAccel: 7.5 },
  },
  club: {
    label: 'Club Circuit',
    minLen: 1000, maxLen: 10000,
    minWidth: 8,
    maxStraight: 1500,
    pitRequired: false, minPitLen: 100,
    minFirstCornerDist: 100,
    car: { vMax: 62, aLat: 11, aBrake: 14, aAccel: 5 },
  },
};

// d = derived track data from the editor:
// { len, width, closed, straight, corners, pitLen, firstCornerDist }
export function validate(d, presetKey) {
  const p = PRESETS[presetKey] || PRESETS.f1;
  const checks = [];
  const add = (label, ok, value) => checks.push({ label, ok, value });

  if (!d || !d.len) return [{ label: 'Draw a track to begin', ok: null, value: '' }];

  add('Closed circuit', d.closed, d.closed ? 'loop' : 'open — close the loop');
  add(
    `Length ${(p.minLen / 1000).toFixed(1)}–${(p.maxLen / 1000).toFixed(1)} km`,
    d.len >= p.minLen && d.len <= p.maxLen,
    `${(d.len / 1000).toFixed(3)} km`
  );
  add(`Width ≥ ${p.minWidth} m`, d.width >= p.minWidth, `${d.width} m`);
  add(
    `Longest straight ≤ ${p.maxStraight} m`,
    d.straight <= p.maxStraight,
    `${Math.round(d.straight)} m`
  );
  if (p.pitRequired) {
    const hasPit = d.pitLen >= p.minPitLen;
    add(`Pit lane ≥ ${p.minPitLen} m`, hasPit,
      d.pitLen > 0 ? `${Math.round(d.pitLen)} m` : 'none drawn');
  }
  if (d.closed && d.corners && d.corners.length) {
    add(
      `Run to first corner ≥ ${p.minFirstCornerDist} m`,
      d.firstCornerDist >= p.minFirstCornerDist,
      `${Math.round(d.firstCornerDist)} m`
    );
    add('At least 8 corners', d.corners.length >= 8, `${d.corners.length}`);
  }
  return checks;
}
