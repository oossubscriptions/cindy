// Auto-detect mode: recognise which exercise is being done and count it, with no workout chosen.
// 1. Every camera movement detector from counter.js runs on each frame; a resolver settles overlaps
//    (a burpee contains a push-up-like plank and a squat-like stand; a thruster is a squat plus a press).
// 2. A periodic-motion counter catches any other repeated exercise and names the common ones.
// 3. FreeSession groups the reps into sets.
// Pure logic, no DOM: unit-tested in test/detect.test.mjs.
import { RepDetector, CAMERA_MOVES, MOVES, angle, P, MIN_VIS, clock } from './counter.js';

const vis = p => (p ? (p.visibility ?? 1) : 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(vis(a), vis(b)) });
const seen = (lm, ...idx) => idx.every(i => vis(lm[i]) >= MIN_VIS);

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
    this.generic = new PeriodicCounter();
    this.pending = [];
    this.recent = [];       // confirmed known reps: { key, t }
    this.lastKnown = -Infinity;
    this.legs = { spread: 0, diff: 0 };
    this.lastName = null; this.lastAt = -Infinity;
    this.track = [];         // recent wrist and shoulder heights, for the pull-up check
  }

  update(raw, t, aspect = 1) {
    const lm = raw.map(p => ({ x: p.x * aspect, y: p.y, visibility: p.visibility }));
    this.trackLegs(lm);
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
    else if (g.reps && !this.pending.length && t - this.lastKnown > GENERIC_QUIET) {
      for (let i = 0; i < g.reps; i++) reps.push({ key: 'other', label: g.name, t });
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
  trackLegs(lm) {
    if (!seen(lm, ...P.HIP, ...P.KN, ...P.AN)) return;
    const k = [0, 1].map(s => angle(lm[P.HIP[s]], lm[P.KN[s]], lm[P.AN[s]]));
    if (Math.min(...k) > 125) return;
    const leg = [0, 1].map(s => dist(lm[P.HIP[s]], lm[P.KN[s]]) + dist(lm[P.KN[s]], lm[P.AN[s]]));
    const legLen = (leg[0] + leg[1]) / 2 || 0.4;
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
        key = this.legs.spread > 0.7 || this.legs.diff > 40 ? 'lunge' : 'squat';
        this.legs = { spread: 0, diff: 0 };
      }
      out.push({ key, t: p.t });
      this.recent.push({ key, t: p.t }); if (this.recent.length > 10) this.recent.shift();
      this.lastKnown = t;
    }
    return out;
  }
}

// Counts any repeated movement: finds the body signal with the biggest steady swing over the last
// few seconds and counts its cycles. Needs 3 consistent cycles before it reports (then counts all 3).
const SIGNALS = { wristY: 0.35, hipY: 0.25, shY: 0.25, elbow: 0.45, knee: 0.45, hip: 0.45 }; // min swing to count
export class PeriodicCounter {
  constructor(windowMs = 10000) { this.windowMs = windowMs; this.buf = []; this.reset(); }
  reset() { this.sig = null; this.state = null; this.cycles = []; this.confirmed = false; this.name = null; }

  features(lm) {
    if (!seen(lm, ...P.SH, ...P.HIP)) return null;
    const sh = mid(lm[11], lm[12]), hip = mid(lm[23], lm[24]);
    const S = dist(sh, hip) || 0.2;
    const s = { hipY: hip.y / S, shY: sh.y / S };
    const post = { tilt: Math.atan2(Math.abs(sh.y - hip.y), Math.abs(sh.x - hip.x)) * 180 / Math.PI };
    if (seen(lm, ...P.WR)) {
      const wr = mid(lm[15], lm[16]);
      s.wristY = (wr.y - sh.y) / S;
      post.overhead = wr.y < lm[P.NOSE].y; post.low = wr.y > sh.y + 0.15 * S;
    }
    if (seen(lm, ...P.EL, ...P.WR)) s.elbow = (angle(lm[11], lm[13], lm[15]) + angle(lm[12], lm[14], lm[16])) / 180;
    if (seen(lm, ...P.KN)) {
      s.hip = (angle(lm[11], lm[23], lm[25]) + angle(lm[12], lm[24], lm[26])) / 180;
      if (seen(lm, ...P.AN)) { s.knee = (angle(lm[23], lm[25], lm[27]) + angle(lm[24], lm[26], lm[28])) / 180; post.knee = s.knee * 90; }
    }
    return { s, post };
  }

  update(lm, t) {
    const f = this.features(lm);
    if (!f) return { reps: 0 };
    this.buf.push({ t, ...f });
    while (this.buf.length && t - this.buf[0].t > this.windowMs) this.buf.shift();
    if (t - this.buf[0].t < 1500) return { reps: 0 };
    let best = null, bestScore = 1, lo = 0, hi = 0;
    for (const [k, need] of Object.entries(SIGNALS)) {
      const vals = this.buf.map(b => b.s[k]).filter(v => v != null);
      if (vals.length < this.buf.length * 0.8) continue;
      const mn = Math.min(...vals), mx = Math.max(...vals), score = (mx - mn) / need;
      if (score > bestScore) { best = k; bestScore = score; lo = mn; hi = mx; }
    }
    if (!best) { this.reset(); return { reps: 0 }; }
    if (best !== this.sig) { this.reset(); this.sig = best; }
    const v = f.s[best], m = (lo + hi) / 2, band = (hi - lo) * 0.2;
    let reps = 0;
    if (this.state !== 'hi' && v > m + band) {
      if (this.state === 'lo') {
        reps = this.onCycle(t);
        if (reps === 'confirm') reps = this.retroCount(best, m, band); // count the set from its start
      }
      this.state = 'hi';
    } else if (this.state !== 'lo' && v < m - band) this.state = 'lo';
    return { reps, name: this.name };
  }

  // Rising crossings over the whole window, with the thresholds just learned.
  retroCount(sig, m, band) {
    let st = null, n = 0;
    for (const b of this.buf) {
      const v = b.s[sig]; if (v == null) continue;
      if (st !== 'hi' && v > m + band) { if (st === 'lo') n++; st = 'hi'; } else if (st !== 'lo' && v < m - band) st = 'lo';
    }
    return Math.max(n, this.cycles.length);
  }

  onCycle(t) {
    const prev = this.cycles[this.cycles.length - 1];
    const gap = prev == null ? null : t - prev;
    const lastGap = this.cycles.length > 1 ? prev - this.cycles[this.cycles.length - 2] : null;
    if (gap != null && (gap < 500 || gap > 8000 || (lastGap && (gap > lastGap * 2.2 || gap < lastGap / 2.2)))) {
      this.cycles = [t]; this.confirmed = false;
      return 0;
    }
    this.cycles.push(t);
    if (this.confirmed) return 1;
    if (this.cycles.length >= 3) {
      this.confirmed = true;
      this.name = PeriodicCounter.classify(this.sig, this.buf);
      return 'confirm';
    }
    return 0;
  }

  // Name the common ones from which signal moves and the posture around it.
  static classify(sig, buf) {
    const share = fn => buf.filter(b => fn(b.post)).length / buf.length;
    const lying = share(p => p.tilt < 35) > 0.6;
    const standing = share(p => p.tilt > 60) > 0.6;
    const straightLegs = share(p => p.knee == null || p.knee > 140) > 0.7;
    const overhead = share(p => p.overhead) > 0.15;
    const els = buf.map(b => b.s.elbow).filter(v => v != null);
    const elbowSwing = els.length ? Math.max(...els) - Math.min(...els) : 0; // in units of 180°
    const arms = sig === 'elbow' || sig === 'wristY';
    if (arms && overhead && straightLegs && standing) return 'Shoulder press';
    if (arms && !overhead && standing && elbowSwing > 0.4) return 'Curls';
    if (sig === 'hip' && standing === false && !lying && straightLegs) return 'Hip hinges';
    if (sig === 'hip' && lying) return 'Glute bridges';
    if (sig === 'hipY' && lying) return 'Glute bridges';
    return 'Other movement';
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
