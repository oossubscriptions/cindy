import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoDetector, FreeSession, PeriodicCounter } from '../detect.js';

/* ---------- synthetic poses (side-on unless noted) ---------- */

const at = (o, r, deg) => [o[0] + r * Math.cos(deg * Math.PI / 180), o[1] + r * Math.sin(deg * Math.PI / 180)];
const up = (p, d) => [p[0], p[1] - d];
// pts: named points; a [x,y] sets both sides, {l:[x,y], r:[x,y]} sets each side.
function pose(pts) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const set = (i, p) => { lm[i] = { x: p[0], y: p[1], visibility: 1 }; };
  const pair = (ix, v) => { if (!v) return; if (Array.isArray(v)) { set(ix[0], v); set(ix[1], v); } else { set(ix[0], v.l); set(ix[1], v.r); } };
  if (pts.nose) set(0, pts.nose);
  if (pts.mouth) { set(9, pts.mouth); set(10, pts.mouth); }
  pair([11, 12], pts.sh); pair([13, 14], pts.el); pair([15, 16], pts.wr);
  pair([23, 24], pts.hip); pair([25, 26], pts.kn); pair([27, 28], pts.an);
  return lm;
}
function squat(kneeDeg, arms = 'side') {
  const an = [0.5, 0.9], kn = at(an, 0.2, -80), hip = at(kn, 0.2, 100 - kneeDeg);
  const sh = up(hip, 0.25);
  const a = {
    side: { el: up(hip, 0.12), wr: [hip[0] + 0.02, hip[1] - 0.02] },
    rack: { el: [sh[0] + 0.03, sh[1] + 0.1], wr: [sh[0] + 0.05, sh[1] - 0.02] },
    overhead: { el: up(sh, 0.12), wr: up(sh, 0.24) },
  }[arms];
  return pose({ an, kn, hip, sh, nose: up(hip, 0.35), mouth: up(hip, 0.33), ...a });
}
function pushup(elbowDeg) {
  const wr = [0.3, 0.8], el = [0.3, 0.68], sh = at(el, 0.12, -90 + (180 - elbowDeg));
  return pose({ wr, el, sh, hip: [sh[0] + 0.3, sh[1] + 0.03], kn: [sh[0] + 0.45, sh[1] + 0.06], an: [sh[0] + 0.6, sh[1] + 0.08], nose: [sh[0] - 0.08, sh[1]], mouth: [sh[0] - 0.08, sh[1] + 0.01] });
}
function lunge(low) {
  if (!low) return squat(178);
  const hip = [0.5, 0.62];
  return pose({ hip, kn: { l: [0.62, 0.66], r: [0.42, 0.84] }, an: { l: [0.62, 0.88], r: [0.28, 0.86] },
    sh: up(hip, 0.25), el: up(hip, 0.12), wr: [hip[0] + 0.02, hip[1] - 0.02], nose: up(hip, 0.35), mouth: up(hip, 0.33) });
}
function pullup(top) {
  const wr = [0.5, 0.2], sh = top ? [0.5, 0.3] : [0.5, 0.44], el = top ? [0.42, 0.33] : [0.5, 0.32], mouth = top ? [0.5, 0.18] : [0.5, 0.36];
  return pose({ wr, el, sh, mouth, nose: up(mouth, 0.02), hip: [0.5, sh[1] + 0.3], kn: [0.5, sh[1] + 0.5], an: [0.5, sh[1] + 0.7] });
}
function situp(hipDeg) {
  const hip = [0.4, 0.8], kn = [0.6, 0.7], sh = at(hip, 0.25, -26.57 - hipDeg);
  return pose({ hip, kn, an: [0.75, 0.85], sh, el: [sh[0] + 0.05, sh[1] + 0.05], wr: [sh[0] + 0.1, sh[1] + 0.05], nose: up(sh, 0.05), mouth: up(sh, 0.04) });
}
function jack(open) { // facing the camera
  const o = open;
  return pose({
    nose: [0.5, 0.2], mouth: [0.5, 0.22], sh: { l: [0.45, 0.3], r: [0.55, 0.3] },
    el: o ? { l: [0.4, 0.2], r: [0.6, 0.2] } : { l: [0.43, 0.42], r: [0.57, 0.42] },
    wr: o ? { l: [0.38, 0.1], r: [0.62, 0.1] } : { l: [0.42, 0.54], r: [0.58, 0.54] },
    hip: { l: [0.46, 0.55], r: [0.54, 0.55] },
    kn: o ? { l: [0.42, 0.72], r: [0.58, 0.72] } : { l: [0.465, 0.72], r: [0.535, 0.72] },
    an: o ? { l: [0.38, 0.9], r: [0.62, 0.9] } : { l: [0.47, 0.9], r: [0.53, 0.9] },
  });
}
function curl(upArm) { // standing, facing the camera, upper arms down by the sides
  const el = { l: [0.44, 0.45], r: [0.56, 0.45] };
  const wr = upArm ? { l: [0.44, 0.33], r: [0.56, 0.33] } : { l: [0.445, 0.6], r: [0.555, 0.6] };
  return pose({ nose: [0.5, 0.2], mouth: [0.5, 0.22], sh: { l: [0.44, 0.3], r: [0.56, 0.3] }, el, wr,
    hip: { l: [0.46, 0.55], r: [0.54, 0.55] }, kn: { l: [0.46, 0.72], r: [0.54, 0.72] }, an: { l: [0.46, 0.9], r: [0.54, 0.9] } });
}

// Play frames through a detector: each pose is held for `hold` frames, 100 ms apart.
function play(det, poses, { hold = 4, tail = 25, t0 = 0 } = {}) {
  const reps = []; let t = t0;
  const step = f => { t += 100; for (const r of det.update(f, t).reps) reps.push(r.label || r.key); };
  for (const f of poses) for (let k = 0; k < hold; k++) step(f);
  for (let k = 0; k < tail; k++) step(poses[poses.length - 1]); // let held candidates resolve
  return { reps, t };
}
const times = (n, seq) => Array.from({ length: n }, () => seq).flat();
const count = (arr, v) => arr.filter(x => x === v).length;

/* ---------- known movements ---------- */

test('squats are recognised as squats only', () => {
  const { reps } = play(new AutoDetector(), [squat(178), ...times(5, [squat(80), squat(178)])]);
  assert.equal(count(reps, 'squat'), 5); assert.equal(reps.length, 5);
});

test('lunges (split stance) are told apart from squats', () => {
  const { reps } = play(new AutoDetector(), [lunge(false), ...times(4, [lunge(true), lunge(false)])]);
  assert.equal(count(reps, 'lunge'), 4); assert.equal(reps.length, 4);
});

test('push-ups are counted', () => {
  const { reps } = play(new AutoDetector(), [pushup(170), ...times(6, [pushup(80), pushup(170)])]);
  assert.equal(count(reps, 'pushup'), 6); assert.equal(reps.length, 6);
});

test('burpees count as burpees, not push-ups or squats', () => {
  const { reps } = play(new AutoDetector(), times(4, [squat(178), pushup(170), pushup(80), pushup(170), squat(178)]), { hold: 5 });
  assert.equal(count(reps, 'burpee'), 4, reps.join());
  assert.equal(reps.length, 4, reps.join());
});

test('thrusters count as thrusters, not squats', () => {
  const { reps } = play(new AutoDetector(), [squat(178, 'rack'), ...times(4, [squat(80, 'rack'), squat(178, 'overhead'), squat(178, 'rack')])]);
  assert.equal(count(reps, 'thruster'), 4, reps.join()); assert.equal(reps.length, 4, reps.join());
});

test('pull-ups, sit-ups and jumping jacks', () => {
  assert.deepEqual(play(new AutoDetector(), [pullup(false), ...times(3, [pullup(true), pullup(false)])]).reps, ['pullup', 'pullup', 'pullup']);
  const s = play(new AutoDetector(), [situp(150), ...times(3, [situp(55), situp(150)])]).reps;
  assert.equal(count(s, 'situp'), 3, s.join()); assert.equal(s.length, 3, s.join());
  const j = play(new AutoDetector(), [jack(false), ...times(5, [jack(true), jack(false)])]).reps;
  assert.equal(count(j, 'jack'), 5, j.join()); assert.equal(j.length, 5, j.join());
});

test('switching movements mid-session', () => {
  const d = new AutoDetector();
  const a = play(d, [squat(178), ...times(3, [squat(80), squat(178)])]);
  const b = play(d, [pushup(170), ...times(3, [pushup(80), pushup(170)])], { t0: a.t });
  assert.deepEqual([...a.reps, ...b.reps], ['squat', 'squat', 'squat', 'pushup', 'pushup', 'pushup']);
});

test('standing still counts nothing', () => {
  assert.equal(play(new AutoDetector(), [squat(178)], { tail: 120 }).reps.length, 0);
});

/* ---------- anything else: periodic counter ---------- */

test('unknown repeated movement (curls) is counted and named', () => {
  const { reps } = play(new AutoDetector(), [curl(false), ...times(10, [curl(true), curl(false)])]);
  assert.ok(reps.length >= 9 && reps.length <= 10, `counted ${reps.length}`);
  assert.ok(reps.every(r => r === 'Curls'), reps.join());
});

function press(top) { // standing, facing the camera, dumbbells from shoulders to overhead
  return pose({ nose: [0.5, 0.2], mouth: [0.5, 0.22], sh: { l: [0.44, 0.3], r: [0.56, 0.3] },
    el: top ? { l: [0.43, 0.17], r: [0.57, 0.17] } : { l: [0.38, 0.38], r: [0.62, 0.38] },
    wr: top ? { l: [0.43, 0.04], r: [0.57, 0.04] } : { l: [0.39, 0.27], r: [0.61, 0.27] },
    hip: { l: [0.46, 0.55], r: [0.54, 0.55] }, kn: { l: [0.46, 0.72], r: [0.54, 0.72] }, an: { l: [0.46, 0.9], r: [0.54, 0.9] } });
}

test('shoulder press is named, and never mistaken for pull-ups', () => {
  const { reps } = play(new AutoDetector(), [press(false), ...times(8, [press(true), press(false)])]);
  assert.equal(count(reps, 'pullup'), 0, reps.join());
  assert.ok(reps.length >= 7 && reps.length <= 8, `counted ${reps.length}`);
  assert.ok(reps.every(r => r === 'Shoulder press'), reps.join());
});

test('periodic counter ignores jitter and erratic motion', () => {
  const pc = new PeriodicCounter();
  let n = 0, t = 0;
  for (let i = 0; i < 200; i++) { t += 100; const f = curl(false).map(p => ({ ...p, y: p.y + (Math.random() - 0.5) * 0.004 })); n += pc.update(f, t).reps || 0; }
  assert.equal(n, 0);
  const pc2 = new PeriodicCounter(); n = 0; t = 0;
  for (const hold of [2, 30, 3, 25]) for (let k = 0; k < hold; k++) { t += 100; n += pc2.update(curl(hold % 2 === 0), t).reps || 0; }
  assert.equal(n, 0); // two odd swings far apart are not a rhythm
});

/* ---------- freestyle sets ---------- */

test('FreeSession groups reps into sets', () => {
  const s = new FreeSession();
  assert.equal(s.add(1000, 'squat'), 'set');
  s.add(2000, 'squat'); s.add(3000, 'squat');
  assert.equal(s.add(5000, 'pushup'), 'set');
  s.add(6000, 'pushup');
  assert.equal(s.add(40000, 'pushup'), 'set'); // long pause: new set
  s.add(41000, 'other', 'Curls');
  assert.equal(s.total, 7); assert.equal(s.sets.length, 4); assert.equal(s.score, '7 reps');
  assert.deepEqual(s.totals().map(x => `${x.name}:${x.reps}`), ['Air squats:3', 'Push-ups:3', 'Curls:1']);
  assert.equal(s.chunk()[0].label, 'Curls');
  s.complete(); assert.equal(s.current, null);
  assert.equal(s.add(42000), 'set');           // +1 with no current set goes to Other
  assert.equal(s.step.label, 'Other');
  s.undo(); s.undo();
  assert.equal(s.total, 6); assert.equal(s.sets.length, 3);
  assert.equal(s.current, null);               // the set was closed before those reps
});

test('FreeSession +1 adds to the current set', () => {
  const s = new FreeSession();
  s.add(1000, 'squat'); assert.equal(s.add(1500), 'rep');
  assert.equal(s.current.reps, 2); assert.equal(s.step.key, 'squat');
});
