import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepDetector, Session, WORKOUTS, MOVES, angle, Smoother, clock, describe, ladder } from '../counter.js';

/* ---------- synthetic poses ---------- */

// Build a 33-point pose; both body sides get the same point. Unspecified points sit mid-frame.
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
const up = (p, d) => [p[0], p[1] - d];

function squat(kneeDeg, arms = 'side') {
  const an = [0.5, 0.9], kn = at(an, 0.2, -80);   // knee→ankle points at 100°
  const hip = at(kn, 0.2, 100 - kneeDeg);         // thigh rotated kneeDeg away from the shin
  const sh = up(hip, 0.25), nose = up(hip, 0.35);
  const armPts = {
    side: { el: up(hip, 0.15), wr: up(hip, 0.1) },
    rack: { el: [sh[0] + 0.03, sh[1] + 0.1], wr: [sh[0] + 0.05, sh[1] - 0.02] },
    overhead: { el: up(sh, 0.12), wr: up(sh, 0.24) },
  }[arms];
  return pose({ an, kn, hip, sh, nose, mouth: up(hip, 0.33), ...armPts });
}
function pushup(elbowDeg) {
  const wr = [0.3, 0.8], el = [0.3, 0.68];                 // forearm vertical
  const sh = at(el, 0.12, -90 + (180 - elbowDeg));         // upper arm rotated toward the feet
  return pose({ wr, el, sh, hip: [sh[0] + 0.3, sh[1] + 0.03], kn: [sh[0] + 0.45, sh[1] + 0.06], an: [sh[0] + 0.6, sh[1] + 0.08], nose: [sh[0] - 0.08, sh[1]], mouth: [sh[0] - 0.08, sh[1] + 0.01] });
}
function pullup(top) {
  const wr = [0.5, 0.2];
  const sh = top ? [0.5, 0.3] : [0.5, 0.44];
  const el = top ? [0.42, 0.33] : [0.5, 0.32];
  const mouth = top ? [0.5, 0.18] : [0.5, 0.36];
  return pose({ wr, el, sh, mouth, nose: [mouth[0], mouth[1] - 0.02], hip: [0.5, sh[1] + 0.3], kn: [0.5, sh[1] + 0.5], an: [0.5, sh[1] + 0.7] });
}
function situp(hipDeg) {
  const hip = [0.4, 0.8], kn = [0.6, 0.7];                 // thigh up at ~27°, hip→knee points at -26.6°
  const sh = at(hip, 0.25, -26.57 - hipDeg);
  return pose({ hip, kn, an: [0.75, 0.85], sh, el: sh, wr: sh, nose: up(sh, 0.05), mouth: up(sh, 0.04) });
}
function jack(open) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const put = (i, x, y) => { lm[i] = { x, y, visibility: 1 }; };
  put(0, 0.5, 0.2); put(11, 0.45, 0.3); put(12, 0.55, 0.3); put(23, 0.46, 0.55); put(24, 0.54, 0.55);
  if (open) { put(15, 0.4, 0.1); put(16, 0.6, 0.1); put(27, 0.4, 0.9); put(28, 0.6, 0.9); }
  else { put(15, 0.42, 0.5); put(16, 0.58, 0.5); put(27, 0.47, 0.9); put(28, 0.53, 0.9); }
  return lm;
}

function run(det, frames) {
  let reps = 0, t = 0;
  for (const f of frames) for (let k = 0; k < 4; k++) { t += 100; if (det.update(f, t).rep) reps++; }
  return reps;
}

/* ---------- geometry ---------- */

test('angle', () => {
  assert.equal(Math.round(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })), 90);
  assert.equal(Math.round(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 180);
});

test('synthetic poses produce the intended joint angles', () => {
  const pt = (lm, i) => ({ x: lm[i].x, y: lm[i].y });
  const s = squat(90); assert.equal(Math.round(angle(pt(s, 23), pt(s, 25), pt(s, 27))), 90);
  const p = pushup(80); assert.equal(Math.round(angle(pt(p, 11), pt(p, 13), pt(p, 15))), 80);
  const u = situp(140); assert.equal(Math.round(angle(pt(u, 11), pt(u, 23), pt(u, 25))), 140);
});

/* ---------- detectors ---------- */

test('squats: counts full reps only', () => {
  const d = new RepDetector('squat');
  assert.equal(run(d, [squat(175), squat(80), squat(175), squat(85), squat(175)]), 2);
  assert.equal(run(d, [squat(140), squat(175), squat(135), squat(175)]), 0); // half squats
});

test('push-ups: counts lockout after chest-down, ignores shallow reps and standing', () => {
  const d = new RepDetector('pushup');
  assert.equal(run(d, [pushup(170), pushup(80), pushup(170), pushup(80), pushup(170), pushup(80)]), 2);
  assert.equal(run(d, [pushup(170), pushup(130), pushup(170)]), 0);
  assert.equal(run(new RepDetector('pushup'), [squat(175), squat(175)]), 0);
});

test('pull-ups: counts chin over bar after a full hang only', () => {
  assert.equal(run(new RepDetector('pullup'), [pullup(false), pullup(true), pullup(false), pullup(true), pullup(true), pullup(false)]), 2);
  const d = new RepDetector('pullup');
  assert.equal(run(d, [pullup(false), pullup(true)]), 1);
  assert.equal(run(d, [pullup(true), pullup(true)]), 0);
});

test('sit-ups: counts sitting up after lying back', () => {
  const d = new RepDetector('situp');
  assert.equal(run(d, [situp(150), situp(55), situp(150), situp(55), situp(150)]), 2);
  assert.equal(run(d, [situp(100), situp(150), situp(95)]), 0); // crunches that don't come up
});

test('thrusters: first rep counts from the rack, needs depth and lockout', () => {
  const d = new RepDetector('thruster');
  const rack = squat(175, 'rack'), bottom = squat(80, 'rack'), top = squat(175, 'overhead');
  assert.equal(run(d, [rack, bottom, top, rack, bottom, top]), 2);
  assert.equal(run(d, [rack, squat(140, 'rack'), top]), 0); // no depth
  assert.equal(run(d, [rack, bottom, rack]), 0);              // no lockout
});

test('burpees: chest to floor then stand', () => {
  const d = new RepDetector('burpee');
  assert.equal(run(d, [squat(175), pushup(80), squat(175), pushup(170), squat(175)]), 2);
});

test('lunges: knee depth then stand', () => {
  const d = new RepDetector('lunge');
  assert.equal(run(d, [squat(175), squat(90), squat(175), squat(140), squat(175)]), 1);
});

test('jumping jacks: arms overhead and feet wide', () => {
  const d = new RepDetector('jack');
  assert.equal(run(d, [jack(false), jack(true), jack(false), jack(true), jack(false)]), 2);
});

test('manual movements never auto-count', () => {
  const d = new RepDetector('doubleunder');
  assert.equal(run(d, [jack(false), jack(true), jack(false)]), 0);
});

test('hidden body reports not visible', () => {
  const r = new RepDetector('squat').update(squat(170).map(p => ({ ...p, visibility: 0.1 })), 0);
  assert.equal(r.visible, false);
});

test('rapid jitter is rate-limited', () => {
  const d = new RepDetector('squat', 'standard', { frames: 1, minGapMs: 350 });
  let reps = 0;
  [squat(175), squat(80), squat(175), squat(80), squat(175)].forEach((f, i) => { if (d.update(f, i * 50).rep) reps++; });
  assert.equal(reps, 1);
});

test('smoother keeps first frame and blends later ones', () => {
  const s = new Smoother(0.5);
  s.push([{ x: 0, y: 0, visibility: 1 }]);
  assert.equal(s.push([{ x: 1, y: 1, visibility: 1 }])[0].x, 0.5);
});

/* ---------- sessions ---------- */

const byId = id => WORKOUTS.find(w => w.id === id);

test('AMRAP (Cindy): rounds, partial reps, undo across a round', () => {
  const w = new Session(byId('cindy'));
  const evs = [];
  for (let i = 0; i < 30; i++) evs.push(w.add(i * 1000));
  assert.equal(w.score, '1 + 0');
  assert.equal(evs[4], 'move'); assert.equal(evs[14], 'move'); assert.equal(evs[29], 'round');
  w.add(31000); w.add(32000);
  assert.equal(w.score, '1 + 2'); assert.equal(w.total, 32);
  w.undo(); w.undo(); w.undo();
  assert.equal(w.score, '0 + 29'); assert.equal(w.step.key, 'squat'); assert.equal(w.splits.length, 0);
  assert.equal(new Session(byId('cindy')).undo(), false);
});

test('For time (Fran): walks the 21-15-9 ladder and finishes', () => {
  const w = new Session(byId('fran'));
  assert.equal(w.flat.length, 6);
  assert.deepEqual(w.chunk().map(c => c.reps), [21, 21, 15, 15, 9, 9]);
  let ev;
  for (let i = 0; i < 89; i++) ev = w.add(i * 1000);
  assert.equal(ev, 'rep'); assert.equal(w.step.key, 'pullup'); assert.equal(w.remainingInStep, 1);
  assert.equal(w.add(250000), 'done');
  assert.equal(w.done, true); assert.equal(w.score, '4:10'); assert.equal(w.add(251000), null);
  assert.equal(w.chunk().every(c => c.done === c.reps), true);
  w.undo();
  assert.equal(w.done, false); assert.equal(w.score, '89 reps');
});

test('For time with rounds: round events and chunk per round', () => {
  const w = new Session({ format: 'fortime', minutes: 10, rounds: 3, seq: [{ key: 'squat', reps: 2 }, { key: 'pushup', reps: 1 }] });
  const evs = [];
  for (let i = 0; i < 9; i++) evs.push(w.add(i));
  assert.deepEqual(evs, ['rep', 'move', 'round', 'rep', 'move', 'round', 'rep', 'move', 'done']);
  assert.equal(w.totalRounds, 3);
  assert.equal(w.roundTimes().length, 3);
});

test('EMOM: work, rest, missed minutes', () => {
  const w = new Session({ format: 'emom', minutes: 3, emomMode: 'all', seq: [{ key: 'squat', reps: 2 }, { key: 'pushup', reps: 1 }] });
  assert.equal(w.add(1000), 'rep'); assert.equal(w.add(2000), 'move'); assert.equal(w.add(20000), 'minute');
  assert.equal(w.resting, true); assert.equal(w.add(21000), null);
  assert.equal(w.tick(1), true);
  assert.equal(w.add(61000), 'rep');
  assert.equal(w.tick(2), false);           // minute 2's work was not finished
  assert.deepEqual(w.missed, [1]);
  assert.equal(w.score, '1/3'); assert.deepEqual(w.roundTimes(), [20000]);
  assert.equal(w.undo(), false);            // cannot undo into a past minute
  assert.equal(w.tick(2), null);            // same minute twice is ignored
});

test('EMOM alternating: each minute takes the next movement', () => {
  const w = new Session(byId('jacks-squats'));
  assert.equal(w.step.key, 'lunge');
  w.tick(1); assert.equal(w.step.key, 'squat');
  w.tick(2); assert.equal(w.step.key, 'jack');
  w.tick(3); assert.equal(w.step.key, 'lunge');
});

test('complete() fills the current movement (manual moves)', () => {
  const w = new Session(byId('murph'));
  assert.equal(w.step.label, 'Run 1 mile');
  assert.equal(w.complete(400000), 'move');
  assert.equal(w.step.key, 'pullup');
  assert.equal(w.complete(500000), 'move');
  assert.equal(w.total, 101);
});

test('rank: finished beats capped, faster beats slower', () => {
  const mk = n => { const w = new Session({ format: 'fortime', minutes: 5, seq: [{ key: 'squat', reps: 3 }] }); for (let i = 0; i < n; i++) w.add(i * 10000 + 10000); return w; };
  const fast = mk(3), capped = mk(2);
  const slow = new Session(fast.def); slow.add(1); slow.add(2); slow.add(90000);
  assert.ok(fast.rank > slow.rank); assert.ok(slow.rank > capped.rank);
});

test('every benchmark is well-formed', () => {
  for (const w of WORKOUTS) {
    assert.ok(['amrap', 'fortime', 'emom'].includes(w.format), w.id);
    assert.ok(w.seq.length && w.seq.every(s => MOVES[s.key] && s.reps > 0), w.id);
    assert.ok(describe(w).length > 10);
    new Session(w).add(0);
  }
  assert.deepEqual(ladder([2, 1], ['a', 'b']).map(s => s.key + s.reps), ['a2', 'b2', 'a1', 'b1']);
});

test('clock formatting', () => {
  assert.equal(clock(0), '0:00'); assert.equal(clock(65000), '1:05'); assert.equal(clock(3725000), '1:02:05');
});
