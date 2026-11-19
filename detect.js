// Auto-detect mode: recognise which exercise is being done and count it, with no workout chosen.
// 1. Every camera movement detector from counter.js runs on each frame; a resolver settles overlaps
//    (a burpee contains a push-up-like plank and a squat-like stand; a thruster is a squat plus a press).
// 2. A periodic-motion counter catches any other repeated exercise and names the common ones.
// 3. FreeSession groups the reps into sets.
// Pure logic, no DOM: unit-tested in test/detect.test.mjs.
import { RepDetector, CAMERA_MOVES, MOVES, clock } from './counter.js';
import { P, angle, dist, mid, seen, tilt } from './geom.js';
import { PeriodicCounter } from './rhythm.js';
export { PeriodicCounter } from './rhythm.js';


export const FREESTYLE = {
  id: 'free', name: 'Auto-detect', format: 'free', minutes: 60, seq: [],
  desc: 'Do any exercise. Rep Sheet works out what it is and counts your reps and sets.',
};

// Lower-body family: the same rep can trip several detectors. Highest priority wins.
const FAMILY = { burpee: 4, thruster: 3, lunge: 2, squat: 1 };
const MERGE_MS = 800;      // candidates this close together are one rep
const LOWER_HOLD = 450;    // wait before confirming a lower-body rep, to let the family merge
const PUSH_HOLD = 1600;    // wait before confirming a first push-up: it may be the floor part of a burpee
const GENERIC_QUIET = 6000; // the periodic counter only speaks after this long without a known rep

export class AutoDetector {
  constructor(level = 'standard') {
    this.dets = Object.fromEntries(CAMERA_MOVES.map(k => [k, new RepDetector(k, level)]));
    this.generic = new PeriodicCounter({ classify: true });
    this.pending = [];
    this.recent = [];       // confirmed known reps: { key, t }
    this.lastKnown = -Infinity;
    this.legs = { spread: 0, diff: 0 };
    this.lastName = null; this.lastAt = -Infinity;
    this.track = [];         // recent wrist and shoulder heights, for the pull-up check
  }

  update(raw, t, aspect = 1) {
    const lm = raw.map(p => ({ x: p.x * aspect, y: p.y, visibility: p.visibility }));
    this.trackLegs(lm, t);
    this.trackArms(lm, t);
    let phase = null;
    for (const k of CAMERA_MOVES) {
      const r = this.dets[k].update(raw, t, aspect);
      if (r.rep) this.candidate(k, t, lm);
      if (k === this.lastKey && t - this.lastAt < 8000) phase = r.phase;
    }
    const reps = this.resolve(t);
    const g = this.generic.update(lm, t);
    if (reps.length) { this.generic.reset(); }
    else if (typeof g.reps === 'number' && g.reps && !this.pending.length && t - this.lastKnown > GENERIC_QUIET) {
      const key = g.key && g.key !== 'other' ? g.key : 'other';
      for (let i = 0; i < g.reps; i++) reps.push(key === 'other' ? { key, label: 'Other movement', t } : { key, t });
    }
    for (const r of reps) { this.lastName = r.label || MOVES[r.key].name; this.lastKey = r.key; this.lastAt = t; }
    const active = t - this.lastAt < 8000;
    return {
      reps, phase,
      text: active ? `Detected: ${this.lastName}` : this.pending.length ? 'Checking…' : 'Watching for a movement',
      hint: '',
    };
  }

  // Squat vs lunge: lunges have a split stance or very different knee angles at the bottom.
  trackLegs(lm, t) {
    if (!seen(lm, ...P.HIP, ...P.KN, ...P.AN)) return;
    const k = [0, 1].map(s => angle(lm[P.HIP[s]], lm[P.KN[s]], lm[P.AN[s]]));
    if (Math.min(...k) > 125) return;
    const leg = [0, 1].map(s => dist(lm[P.HIP[s]], lm[P.KN[s]]) + dist(lm[P.KN[s]], lm[P.AN[s]]));
    const legLen = (leg[0] + leg[1]) / 2 || 0.4;
    // One foot well off the floor while a knee is bent: high knees, marching or butt kicks, not a squat.
    if (Math.abs(lm[P.AN[0]].y - lm[P.AN[1]].y) / (legLen / 2) > 0.5) this.liftAt = t;
    this.legs.spread = Math.max(this.legs.spread, dist(lm[P.AN[0]], lm[P.AN[1]]) / legLen);
    this.legs.diff = Math.max(this.legs.diff, Math.abs(k[0] - k[1]));
  }

  trackArms(lm, t) {
    if (!seen(lm, ...P.SH, ...P.WR, ...P.HIP)) return;
    const sh = mid(lm[11], lm[12]), wr = mid(lm[15], lm[16]), S = dist(sh, mid(lm[23], lm[24])) || 0.2;
    this.track.push({ t, sh: sh.y / S, wr: wr.y / S });
    while (this.track.length && t - this.track[0].t > 2000) this.track.shift();
  }

  candidate(key, t, lm) {
    if (key === 'situp' && seen(lm, ...P.SH, ...P.HIP) && tilt(mid(lm[11], lm[12]), mid(lm[23], lm[24])) < 40) return; // torso must come up
    if (key === 'pullup') {
      // A pull-up moves the body up to fixed hands; a press or thruster moves the hands instead.
      const r = k => { const v = this.track.map(x => x[k]); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
      if (r('wr') > 0.5 * r('sh')) return;
    }
    if (key === 'pushup') {
      // Push-ups have straight legs; this keeps sit-ups and kneeling scrambles out.
      const knees = [0, 1].filter(s => seen(lm, P.HIP[s], P.KN[s], P.AN[s]))
        .map(s => angle(lm[P.HIP[s]], lm[P.KN[s]], lm[P.AN[s]]));
      if (knees.length && Math.max(...knees) < 130) return;
      const streak = this.recent.slice(-2);
      const inStreak = streak.length === 2 && streak.every(r => r.key === 'pushup' && t - r.t < 8000);
      this.pending.push({ key, t, due: inStreak ? t : t + PUSH_HOLD });
      return;
    }
    if (key in FAMILY) {
      // Squats, lunges and thrusters are done upright; lying or on all fours it is something else.
      if (key !== 'burpee' && seen(lm, ...P.SH, ...P.HIP) && tilt(mid(lm[11], lm[12]), mid(lm[23], lm[24])) < 55) return;
      if (key === 'burpee') this.pending = this.pending.filter(p => !(p.key === 'pushup' && t - p.t < 3000));
      const near = this.pending.find(p => p.key in FAMILY && Math.abs(t - p.t) < MERGE_MS);
      if (near) { if (FAMILY[key] > FAMILY[near.key]) near.key = key; return; }
      // A family rep right after a confirmed one of higher priority is the same rep, late.
      const last = this.recent[this.recent.length - 1];
      if (last && last.key in FAMILY && t - last.t < MERGE_MS) return;
      this.pending.push({ key, t, due: t + LOWER_HOLD });
      return;
    }
    this.pending.push({ key, t, due: t });
  }

  resolve(t) {
    const out = [];
    this.pending.sort((a, b) => a.t - b.t);
    while (this.pending.length && this.pending[0].due <= t) {
      const p = this.pending.shift();
      let key = p.key;
      if (key === 'squat' || key === 'lunge') {
        const lifted = p.t - (this.liftAt ?? -Infinity) < 1500;
        key = this.legs.spread > 0.7 || this.legs.diff > 40 ? 'lunge' : 'squat';
        this.legs = { spread: 0, diff: 0 };
        if (lifted) continue;
      }
      out.push({ key, t: p.t });
      this.recent.push({ key, t: p.t }); if (this.recent.length > 10) this.recent.shift();
      this.lastKnown = t;
    }
    return out;
  }
}

// Freestyle bookkeeping. Duck-types the parts of Session that the app uses.
const SET_GAP = 20000; // a pause this long, or a new movement, starts a new set
export class FreeSession {
  constructor(def = FREESTYLE) { this.def = def; this.events = []; this.reset(); }
  reset() { this.sets = []; this.total = 0; this.closed = false; this.done = false; this.resting = false; }
  get format() { return 'free'; }
  get current() { return this.closed ? null : this.sets[this.sets.length - 1] || null; }
  get step() {
    const c = this.current;
    return c ? { key: c.key, reps: c.reps, label: c.name } : { key: 'other', reps: 0, label: 'Waiting for a movement' };
  }
  get reps() { return this.current ? this.current.reps : 0; }
  get rounds() { return this.sets.length; }
  get score() { return `${this.total} reps`; }
  get rank() { return this.total; }
  // Name → total reps, most first.
  totals() {
    const m = new Map();
    for (const s of this.sets) m.set(s.name, { key: s.key, reps: (m.get(s.name)?.reps || 0) + s.reps });
    return [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.reps - a.reps);
  }
  add(t = 0, key = null, label = null) {
    if (!key) { const c = this.current; key = c ? c.key : 'other'; label = c ? c.name : label; }
    this.events.push({ type: 'rep', t, key, label });
    return this._rep(t, key, label);
  }
  _rep(t, key, label) {
    const name = label || (MOVES[key] || MOVES.other).name;
    let s = this.current;
    let ev = 'rep';
    if (!s || s.name !== name || t - s.end > SET_GAP) {
      s = { key, name, reps: 0, start: t, end: t };
      this.sets.push(s); this.closed = false; ev = 'set';
    }
    s.reps++; s.end = t; this.total++;
    return ev;
  }
  complete() { // "End set"
    if (!this.current) return null;
    this.events.push({ type: 'close' });
    this.closed = true;
    return 'move';
  }
  undo() {
    let i = this.events.length - 1;
    while (i >= 0 && this.events[i].type !== 'rep') i--;
    if (i < 0) return false;
    this.events.splice(i, 1);
    const evs = this.events;
    this.reset();
    for (const e of evs) { if (e.type === 'rep') this._rep(e.t, e.key, e.label); else this.closed = true; }
    return true;
  }
  // Recent sets, newest first, for the board.
  chunk() { return this.sets.slice(-6).reverse().map(s => ({ key: s.key, label: s.name, reps: s.reps, done: s.reps, start: s.start })); }
  roundTimes() { return []; }
  describeSets() { return this.totals().map(x => `${x.reps} ${x.name.toLowerCase()}`).join(', '); }
  summaryLine(ms) { return `${this.total} reps in ${this.sets.length} set${this.sets.length === 1 ? '' : 's'} over ${clock(ms)}`; }
}
