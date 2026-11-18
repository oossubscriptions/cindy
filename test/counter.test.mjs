import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepDetector, Workout, angle, Smoother } from '../counter.js';

// Build a 33-point pose; unspecified points sit at the hip with full visibility.
function pose(pts) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const set = (i, p) => { lm[i] = { x: p[0], y: p[1], visibility: 1 }; };
  const both = (pair, p) => { set(pair[0], p); set(pair[1], p); };
  if (pts.nose) set(0, pts.nose);
  if (pts.mouth) { set(9, pts.mouth); set(10, pts.mouth); }
  both([11, 12], pts.sh); both([13, 14], pts.el); both([15, 16], pts.wr);
  both([23, 24], pts.hip); both([25, 26], pts.kn); both([27, 28], pts.an);
  return lm;
}
// Point at distance r from origin o, at `deg` degrees (0 = right, 90 = down in screen coords).
const at = (o, r, deg) => [o[0] + r * Math.cos(deg * Math.PI / 180), o[1] + r * Math.sin(deg * Math.PI / 180)];

function squat(kneeDeg) {
  const an = [0.5, 0.9], kn = at(an, 0.2, -80);           // shin leaning slightly (knee→ankle points at 100°)
  const hipPt = at(kn, 0.2, 100 - kneeDeg);                // thigh rotated kneeDeg away from the shin
  return pose({ an, kn, hip: hipPt, sh: [hipPt[0], hipPt[1] - 0.25], el: [hipPt[0], hipPt[1] - 0.15], wr: [hipPt[0], hipPt[1] - 0.1], nose: [hipPt[0], hipPt[1] - 0.35], mouth: [hipPt[0], hipPt[1] - 0.33] });
}

function pushup(elbowDeg) {
  const wr = [0.3, 0.8], el = [0.3, 0.68];                 // forearm vertical
  const sh = at(el, 0.12, -90 + (180 - elbowDeg));         // upper arm rotated toward feet
  return pose({ wr, el, sh, hip: [sh[0] + 0.3, sh[1] + 0.03], kn: [sh[0] + 0.45, sh[1] + 0.06], an: [sh[0] + 0.6, sh[1] + 0.08], nose: [sh[0] - 0.08, sh[1]], mouth: [sh[0] - 0.08, sh[1] + 0.01] });
}

function pullup(top) {
  const wr = [0.5, 0.2];
  const sh = top ? [0.5, 0.3] : [0.5, 0.44];
  const el = top ? [0.42, 0.33] : [0.5, 0.32];
  const mouth = top ? [0.5, 0.18] : [0.5, 0.36];
  return pose({ wr, el, sh, mouth, nose: [mouth[0], mouth[1] - 0.02], hip: [0.5, sh[1] + 0.3], kn: [0.5, sh[1] + 0.5], an: [0.5, sh[1] + 0.7] });
}

function run(det, frames) {
  let reps = 0, t = 0;
  for (const f of frames) for (let k = 0; k < 4; k++) { t += 100; if (det.update(f, t).rep) reps++; }
  return reps;
}

test('angle', () => {
  assert.equal(Math.round(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })), 90);
  assert.equal(Math.round(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 180);
});

test('synthetic poses produce the intended joint angles', () => {
  const s = squat(90); assert.equal(Math.round(angle(
    { x: s[23].x, y: s[23].y }, { x: s[25].x, y: s[25].y }, { x: s[27].x, y: s[27].y })), 90);
  const p = pushup(80); assert.equal(Math.round(angle(
    { x: p[11].x, y: p[11].y }, { x: p[13].x, y: p[13].y }, { x: p[15].x, y: p[15].y })), 80);
});

test('squats: counts full reps only', () => {
  const d = new RepDetector('squat');
  assert.equal(run(d, [squat(175), squat(80), squat(175), squat(85), squat(175)]), 2);
  // half squats do not count
  assert.equal(run(d, [squat(140), squat(175), squat(135), squat(175)]), 0);
});

test('push-ups: counts lockout after chest-down', () => {
  const d = new RepDetector('pushup');
  assert.equal(run(d, [pushup(170), pushup(80), pushup(170), pushup(80), pushup(170), pushup(80)]), 2);
  // shallow reps do not count
  assert.equal(run(d, [pushup(170), pushup(130), pushup(170)]), 0);
});

test('push-ups: ignored when standing upright', () => {
  const d = new RepDetector('pushup');
  const upright = squat(175); // vertical torso
  assert.equal(run(d, [upright, upright]), 0);
});

test('pull-ups: counts chin over bar after a full hang', () => {
  const d = new RepDetector('pullup');
  assert.equal(run(d, [pullup(false), pullup(true), pullup(false), pullup(true), pullup(true), pullup(false)]), 2);
});

test('pull-ups: no rep without returning to a hang', () => {
  const d = new RepDetector('pullup');
  assert.equal(run(d, [pullup(false), pullup(true)]), 1);
  assert.equal(run(d, [pullup(true), pullup(true)]), 0);
});

test('hidden body reports not visible', () => {
  const d = new RepDetector('squat');
  const lm = squat(170).map(p => ({ ...p, visibility: 0.1 }));
  const r = d.update(lm, 0);
  assert.equal(r.visible, false);
});

test('rapid jitter is rate-limited', () => {
  const d = new RepDetector('squat', 'standard', { frames: 1, minGapMs: 350 });
  let reps = 0;
  [squat(175), squat(80), squat(175), squat(80), squat(175)].forEach((f, i) => { if (d.update(f, i * 50).rep) reps++; });
  assert.equal(reps, 1);
});

test('workout: rounds, partial reps, undo', () => {
  const w = new Workout();
  const evs = [];
  for (let i = 0; i < 30; i++) evs.push(w.add(i * 1000));
  assert.equal(w.score, '1 + 0');
  assert.equal(evs[4], 'move'); assert.equal(evs[14], 'move'); assert.equal(evs[29], 'round');
  w.add(31000); w.add(32000);
  assert.equal(w.score, '1 + 2'); assert.equal(w.total, 32);
  w.undo(); w.undo(); w.undo();
  assert.equal(w.score, '0 + 29'); assert.equal(w.move.key, 'squat'); assert.equal(w.splits.length, 0);
  assert.equal(w.total, 29);
});

test('workout: undo on empty is a no-op', () => {
  const w = new Workout();
  assert.equal(w.undo(), false);
  assert.equal(w.score, '0 + 0');
});

test('round times', () => {
  const w = new Workout({ minutes: 1, moves: [{ key: 'squat', name: 'S', reps: 1 }] });
  w.add(30000); w.add(70000);
  assert.deepEqual(w.roundTimes(), [30000, 40000]);
});

test('smoother keeps first frame and blends later ones', () => {
  const s = new Smoother(0.5);
  s.push([{ x: 0, y: 0, visibility: 1 }]);
  const out = s.push([{ x: 1, y: 1, visibility: 1 }]);
  assert.equal(out[0].x, 0.5);
});
