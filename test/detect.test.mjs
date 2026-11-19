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
  assert.ok(reps.every(r => r === 'curl'), reps.join());
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
  assert.ok(reps.every(r => r === 'press'), reps.join());
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
  s.add(41000, 'curl');
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

/* ---------- warm-ups, floor work and band exercises ---------- */

const F = { nose: [0.5, 0.2], mouth: [0.5, 0.22], sh: { l: [0.44, 0.3], r: [0.56, 0.3] }, hip: { l: [0.46, 0.55], r: [0.54, 0.55] },
  kn: { l: [0.46, 0.72], r: [0.54, 0.72] }, an: { l: [0.46, 0.9], r: [0.54, 0.9] },
  el: { l: [0.43, 0.43], r: [0.57, 0.43] }, wr: { l: [0.43, 0.56], r: [0.57, 0.56] } }; // standing, facing the camera
const front = o => pose({ ...F, ...o });
const S = { nose: [0.52, 0.2], mouth: [0.52, 0.22], sh: [0.5, 0.3], hip: [0.5, 0.55], kn: [0.5, 0.72], an: [0.5, 0.9],
  el: [0.5, 0.43], wr: [0.51, 0.56] }; // standing, side-on, facing right
const side = o => pose({ ...S, ...o });
const shiftY = (o, d) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? [v[0], v[1] + d] : { l: [v.l[0], v.l[1] + d], r: [v.r[0], v.r[1] + d] }]));
const arm = (o, len, deg) => at(o, len, deg);

const MOVEMENTS = {
  highknees: { hold: 2, seq: [side({}), side({ kn: { l: [0.62, 0.56], r: [0.5, 0.72] }, an: { l: [0.62, 0.76], r: [0.5, 0.9] } }),
    side({}), side({ kn: { l: [0.5, 0.72], r: [0.62, 0.56] }, an: { l: [0.5, 0.9], r: [0.62, 0.76] } })] },
  march: { hold: 6, seq: [side({}), side({ kn: { l: [0.6, 0.6], r: [0.5, 0.72] }, an: { l: [0.6, 0.78], r: [0.5, 0.9] } }),
    side({}), side({ kn: { l: [0.5, 0.72], r: [0.6, 0.6] }, an: { l: [0.5, 0.9], r: [0.6, 0.78] } })] },
  buttkicks: { hold: 3, seq: [side({}), side({ kn: { l: [0.48, 0.73], r: [0.5, 0.72] }, an: { l: [0.4, 0.6], r: [0.5, 0.9] } }),
    side({}), side({ kn: { l: [0.5, 0.72], r: [0.48, 0.73] }, an: { l: [0.5, 0.9], r: [0.4, 0.6] } })] },
  latraise: { seq: [front({}), front({ el: { l: [0.36, 0.32], r: [0.64, 0.32] }, wr: { l: [0.27, 0.31], r: [0.73, 0.31] } })] },
  frontraise: { seq: [side({}), side({ el: [0.62, 0.31], wr: [0.74, 0.31] })] },
  pullapart: { seq: [front({ el: { l: [0.47, 0.3], r: [0.53, 0.3] }, wr: { l: [0.49, 0.3], r: [0.51, 0.3] } }),
    front({ el: { l: [0.36, 0.3], r: [0.64, 0.3] }, wr: { l: [0.28, 0.3], r: [0.72, 0.3] } })] },
  armcircles: { hold: 2, perCycle: 1, seq: [30, 100, 170, 100].map(d => front({
    el: { l: arm([0.44, 0.3], 0.12, 90 + d), r: arm([0.56, 0.3], 0.12, 90 - d) }, wr: { l: arm([0.44, 0.3], 0.25, 90 + d), r: arm([0.56, 0.3], 0.25, 90 - d) } })) },
  sidebends: { seq: [front({ sh: { l: [0.36, 0.31], r: [0.48, 0.31] }, el: { l: [0.38, 0.45], r: [0.5, 0.45] }, nose: [0.42, 0.21] }),
    front({ sh: { l: [0.52, 0.31], r: [0.64, 0.31] }, el: { l: [0.5, 0.45], r: [0.62, 0.45] }, nose: [0.58, 0.21] })] },
  twists: { seq: [front({ sh: { l: [0.44, 0.3], r: [0.56, 0.3] }, wr: [0.5, 0.42], el: { l: [0.45, 0.42], r: [0.55, 0.42] } }),
    front({ sh: { l: [0.475, 0.3], r: [0.525, 0.3] }, wr: [0.5, 0.42], el: { l: [0.48, 0.42], r: [0.52, 0.42] } })] },
  calfraises: { seq: [front({}), (() => { const o = shiftY({ ...F }, -0.03); o.an = shiftY({ an: F.an }, -0.012).an; return pose(o); })()] },
  toetouches: { seq: [side({}), side({ sh: [0.585, 0.785], nose: [0.6, 0.86], mouth: [0.6, 0.85], el: [0.57, 0.84], wr: [0.56, 0.9] })] },
  hinge: { seq: [side({ wr: [0.55, 0.4], el: [0.53, 0.38] }), side({ sh: [0.74, 0.53], nose: [0.84, 0.55], mouth: [0.84, 0.56], el: [0.74, 0.6], wr: [0.76, 0.62] })] },
  climbers: { hold: 3, seq: (() => {
    const base = { wr: [0.3, 0.8], el: [0.3, 0.68], sh: [0.3, 0.56], hip: [0.6, 0.59], nose: [0.22, 0.56], mouth: [0.22, 0.57] };
    const legs = (l, r) => pose({ ...base, kn: { l: l[0], r: r[0] }, an: { l: l[1], r: r[1] } });
    const out = [[0.75, 0.62], [0.9, 0.64]], inn = [[0.45, 0.72], [0.58, 0.78]];
    return [legs(out, out), legs(inn, out), legs(out, out), legs(out, inn)];
  })() },
  bridges: { seq: [pose({ sh: [0.3, 0.85], hip: [0.5, 0.85], kn: [0.65, 0.72], an: [0.72, 0.88], el: [0.4, 0.86], wr: [0.48, 0.86], nose: [0.24, 0.83], mouth: [0.25, 0.84] }),
    pose({ sh: [0.3, 0.85], hip: [0.5, 0.74], kn: [0.65, 0.68], an: [0.72, 0.88], el: [0.4, 0.86], wr: [0.48, 0.86], nose: [0.24, 0.83], mouth: [0.25, 0.84] })] },
  legraises: { seq: [pose({ sh: [0.3, 0.85], hip: [0.55, 0.85], kn: [0.75, 0.85], an: [0.95, 0.85], el: [0.42, 0.86], wr: [0.52, 0.86], nose: [0.24, 0.83], mouth: [0.25, 0.84] }),
    pose({ sh: [0.3, 0.85], hip: [0.55, 0.85], kn: [0.55, 0.65], an: [0.55, 0.45], el: [0.42, 0.86], wr: [0.52, 0.86], nose: [0.24, 0.83], mouth: [0.25, 0.84] })] },
  clamshells: { seq: [pose({ sh: [0.3, 0.7], hip: [0.55, 0.72], kn: [0.65, 0.8], an: [0.5, 0.85], el: [0.27, 0.62], wr: [0.25, 0.66], nose: [0.22, 0.68], mouth: [0.23, 0.69] }),
    pose({ sh: [0.3, 0.7], hip: [0.55, 0.72], kn: { l: [0.65, 0.8], r: [0.66, 0.66] }, an: [0.5, 0.85], el: [0.27, 0.62], wr: [0.25, 0.66], nose: [0.22, 0.68], mouth: [0.23, 0.69] })] },
  kickbacks: { seq: (() => {
    const base = { sh: [0.35, 0.6], hip: [0.6, 0.6], el: [0.35, 0.7], wr: [0.35, 0.8], nose: [0.28, 0.6], mouth: [0.28, 0.61] };
    return [pose({ ...base, kn: [0.6, 0.8], an: [0.75, 0.8] }), pose({ ...base, kn: { l: [0.6, 0.8], r: [0.76, 0.63] }, an: { l: [0.75, 0.8], r: [0.9, 0.52] } })];
  })() },
  curl: { seq: [side({ el: [0.5, 0.45], wr: [0.51, 0.6] }), side({ el: [0.5, 0.45], wr: [0.53, 0.32] })] },
  pushdown: { seq: [side({ el: [0.5, 0.45], wr: [0.62, 0.45] }), side({ el: [0.5, 0.45], wr: [0.52, 0.6] })] },
  triceps: { seq: [front({ el: { l: [0.44, 0.12], r: [0.56, 0.12] }, wr: { l: [0.46, 0.24], r: [0.54, 0.24] } }),
    front({ el: { l: [0.44, 0.12], r: [0.56, 0.12] }, wr: { l: [0.44, -0.03], r: [0.56, -0.03] } })] },
  row: { seq: [side({ el: [0.62, 0.36], wr: [0.74, 0.42] }), side({ el: [0.4, 0.4], wr: [0.52, 0.42] })] },
  facepull: { seq: [side({ el: [0.63, 0.3], wr: [0.75, 0.3] }), side({ el: [0.45, 0.28], wr: [0.56, 0.24] })] },
  uprightrow: { seq: [front({ el: { l: [0.42, 0.45], r: [0.58, 0.45] }, wr: { l: [0.47, 0.55], r: [0.53, 0.55] } }),
    front({ el: { l: [0.36, 0.28], r: [0.64, 0.28] }, wr: { l: [0.47, 0.32], r: [0.53, 0.32] } })] },
  latsteps: { seq: [front({}), front({ kn: { l: [0.4, 0.72], r: [0.6, 0.72] }, an: { l: [0.36, 0.9], r: [0.64, 0.9] } })] },
};

for (const [key, m] of Object.entries(MOVEMENTS)) {
  test(`auto-detect names ${key}`, () => {
    const reps = 10, cycle = m.seq.length > 2 ? m.seq : [m.seq[0], m.seq[1]];
    const steps = reps / (m.perCycle ?? (m.seq.length > 2 ? 2 : 1)); // 4-pose leg sequences hold two reps, one per side
    const { reps: got } = play(new AutoDetector(), [m.seq[0], ...times(steps, m.seq.length > 2 ? [...cycle.slice(1), cycle[0]] : [cycle[1], cycle[0]])], { hold: m.hold || 4 });
    const named = count(got, key);
    assert.ok(named >= reps - 2 && got.length <= reps + 1, `${key}: got [${got.join(', ')}]`);
  });
}

test('structured workouts count rhythm movements without naming them', async () => {
  const { RepDetector } = await import('../counter.js');
  const d = new RepDetector('curl');
  let n = 0, t = 0;
  for (const f of [MOVEMENTS.curl.seq[0], ...times(10, [MOVEMENTS.curl.seq[1], MOVEMENTS.curl.seq[0]])]) {
    for (let k = 0; k < 4; k++) { t += 100; const r = d.update(f, t); if (r.rep) n += r.count; }
  }
  assert.ok(n >= 9 && n <= 10, `counted ${n}`);
});

test('high knees and butt kicks are not counted as squats or lunges', () => {
  for (const k of ['highknees', 'buttkicks', 'march']) {
    const m = MOVEMENTS[k];
    const { reps } = play(new AutoDetector(), [m.seq[0], ...times(5, [...m.seq.slice(1), m.seq[0]])], { hold: m.hold });
    assert.equal(reps.filter(r => r === 'squat' || r === 'lunge').length, 0, `${k}: ${reps.join()}`);
  }
});
