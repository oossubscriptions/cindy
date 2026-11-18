// Pure logic: rep detection from pose landmarks + workout bookkeeping (AMRAP, For Time, EMOM).
// No DOM access here so it can be unit-tested in Node (see test/counter.test.mjs).

// MediaPipe Pose landmark indices, as [left, right] pairs.
export const P = {
  NOSE: 0, MOUTH: [9, 10],
  SH: [11, 12], EL: [13, 14], WR: [15, 16],
  HIP: [23, 24], KN: [25, 26], AN: [27, 28],
};

export const MIN_VIS = 0.5;

// Thresholds in degrees (angles) or as a fraction of a body segment (tolerances).
export const LEVELS = {
  strict:   { squatDown: 95,  squatUp: 165, pushDown: 90,  pushUp: 155, pullHang: 150, chinTol: -0.05, hipKneeTol: 0.0,
              situpUp: 65, situpDown: 130, lungeDown: 100, jackLegs: 1.8, jackLegsOn: true, burpeeHands: true },
  standard: { squatDown: 105, squatUp: 160, pushDown: 100, pushUp: 150, pullHang: 140, chinTol: 0.1,  hipKneeTol: 0.15,
              situpUp: 75, situpDown: 120, lungeDown: 110, jackLegs: 1.6, jackLegsOn: true, burpeeHands: false },
  lenient:  { squatDown: 120, squatUp: 150, pushDown: 115, pushUp: 140, pullHang: 125, chinTol: 0.3,  hipKneeTol: 0.3,
              situpUp: 85, situpDown: 110, lungeDown: 125, jackLegs: 1.4, jackLegsOn: false, burpeeHands: false },
};

export function angle(a, b, c) {
  const ab = Math.atan2(a.y - b.y, a.x - b.x);
  const cb = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs((ab - cb) * 180 / Math.PI);
  return d > 180 ? 360 - d : d;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vis = p => (p ? (p.visibility ?? 1) : 0);
// Angle of the a→b line from horizontal, 0..90 degrees.
const tilt = (a, b) => Math.atan2(Math.abs(a.y - b.y), Math.abs(a.x - b.x)) * 180 / Math.PI;

// Pick the body side (0 = left, 1 = right) whose joints are most visible.
function bestSide(lm, groups) {
  const score = s => Math.min(...groups.map(g => vis(lm[g[s]])));
  const l = score(0), r = score(1);
  return l >= r ? { s: 0, v: l } : { s: 1, v: r };
}
const pick = (lm, s) => ({
  sh: lm[P.SH[s]], el: lm[P.EL[s]], wr: lm[P.WR[s]], hip: lm[P.HIP[s]], kn: lm[P.KN[s]], an: lm[P.AN[s]],
});

// Squat depth shared by squats and thrusters: works side-on (knee angle) and facing the camera
// (hips drop to knee height).
function squatState(j, T) {
  const knee = angle(j.hip, j.kn, j.an);
  const shin = dist(j.kn, j.an) || 0.1;
  const low = knee < T.squatDown || j.hip.y >= j.kn.y - T.hipKneeTol * shin;
  const tall = knee > T.squatUp && j.hip.y < j.kn.y - 0.6 * shin;
  return { knee, low, tall };
}

// Each movement has two positions: A (start / lockout) and B (the other end of the range).
// countOn says which arrival completes the rep. manual movements are counted by tapping.
export const MOVES = {
  pullup: {
    name: 'Pull-ups', color: '#4a74d9', countOn: 'B',
    tip: 'Count when your mouth rises above your hands, after a full hang with straight arms. Keep the bar and your hands in frame.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.EL, P.WR]);
      if (v < MIN_VIS) return null;
      const { sh, el, wr } = pick(lm, s);
      const elbow = angle(sh, el, wr);
      const upperArm = dist(sh, el) || 0.1;
      const mouthY = (lm[P.MOUTH[0]].y + lm[P.MOUTH[1]].y) / 2;
      const handsUp = wr.y < sh.y + 0.5 * upperArm;
      return {
        label: 'Elbow', value: elbow,
        A: wr.y < lm[P.NOSE].y && elbow > T.pullHang,
        B: handsUp && mouthY < wr.y + T.chinTol * upperArm,
        hint: handsUp ? '' : 'Hang from the bar with arms straight',
      };
    },
  },
  pushup: {
    name: 'Push-ups', color: '#e8622c', countOn: 'A',
    tip: 'Count when you lock out again after your elbows bend to about 100°, in a plank. Side-on to the camera works best.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.EL, P.WR, P.HIP]);
      if (v < MIN_VIS) return null;
      const { sh, el, wr, hip } = pick(lm, s);
      const elbow = angle(sh, el, wr);
      const plank = tilt(sh, hip) < 50;
      return {
        label: 'Elbow', value: elbow,
        A: plank && elbow > T.pushUp, B: plank && elbow < T.pushDown,
        hint: plank ? '' : 'Get into a plank, side-on to the camera',
      };
    },
  },
  squat: {
    name: 'Air squats', color: '#e0a419', countOn: 'A',
    tip: 'Count when you stand up tall after your hips drop to knee height.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.HIP, P.KN, P.AN]);
      if (v < MIN_VIS) return null;
      const q = squatState(pick(lm, s), T);
      return { label: 'Knee', value: q.knee, A: q.tall, B: q.low, hint: '' };
    },
  },
  situp: {
    name: 'Sit-ups', color: '#139aa3', countOn: 'B',
    tip: 'Lie side-on to the camera. Counts when your shoulders come up over your hips after lying back flat.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.HIP, P.KN]);
      if (v < MIN_VIS) return null;
      const { sh, hip, kn } = pick(lm, s);
      const hipAngle = angle(sh, hip, kn);
      const seated = tilt(hip, kn) < 75; // thighs not vertical, i.e. on the floor, not standing
      return {
        label: 'Hip', value: hipAngle,
        A: seated && hipAngle > T.situpDown, B: seated && hipAngle < T.situpUp,
        hint: seated ? '' : 'Sit on the floor, side-on to the camera',
      };
    },
  },
  thruster: {
    name: 'Thrusters', color: '#a23f9a', countOn: 'A', startFromB: true,
    tip: 'Counts when the bar is locked out overhead after a squat to depth. Keep your hands in frame overhead.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.EL, P.WR, P.HIP, P.KN, P.AN]);
      if (v < MIN_VIS) return null;
      const j = pick(lm, s);
      const q = squatState(j, T);
      const elbow = angle(j.sh, j.el, j.wr);
      const overhead = j.wr.y < lm[P.NOSE].y && elbow > 145;
      return { label: 'Knee', value: q.knee, A: q.tall && overhead, B: q.low, hint: '' };
    },
  },
  burpee: {
    name: 'Burpees', color: '#d9467a', countOn: 'A',
    tip: 'Side-on works best. Counts when you stand back up after your chest goes to the floor.',
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.HIP, P.KN, P.AN]);
      if (v < MIN_VIS) return null;
      const j = pick(lm, s);
      const torso = tilt(j.sh, j.hip);
      const knee = angle(j.hip, j.kn, j.an);
      const handsUp = vis(j.wr) >= MIN_VIS && j.wr.y < lm[P.NOSE].y;
      return {
        label: 'Torso', value: torso,
        A: torso > 60 && knee > 150 && (!T.burpeeHands || handsUp),
        B: torso < 35 && j.sh.y > j.kn.y - dist(j.kn, j.an),
        hint: '',
      };
    },
  },
  lunge: {
    name: 'Lunges', color: '#6e8a1f', countOn: 'A',
    tip: 'Counts when you stand tall after your front knee bends to about 100°. Each leg is one rep.',
    measure(lm, T) {
      const knees = [0, 1].filter(s => Math.min(vis(lm[P.HIP[s]]), vis(lm[P.KN[s]]), vis(lm[P.AN[s]])) >= MIN_VIS)
        .map(s => angle(lm[P.HIP[s]], lm[P.KN[s]], lm[P.AN[s]]));
      if (!knees.length) return null;
      const low = Math.min(...knees);
      return { label: 'Knee', value: low, A: Math.min(...knees) > 155, B: low < T.lungeDown, hint: '' };
    },
  },
  jack: {
    name: 'Jumping jacks', color: '#3aa0d8', countOn: 'B',
    tip: 'Face the camera. Counts when your hands go overhead and your feet go wide.',
    measure(lm, T) {
      const need = [P.SH, P.WR, P.HIP, P.AN].flat();
      if (Math.min(...need.map(i => vis(lm[i]))) < MIN_VIS) return null;
      const shY = (lm[11].y + lm[12].y) / 2, wrY = Math.max(lm[15].y, lm[16].y);
      const hipW = Math.abs(lm[23].x - lm[24].x) || 0.05;
      const feet = Math.abs(lm[27].x - lm[28].x) / hipW;
      const legsOk = !T.jackLegsOn || feet > T.jackLegs;
      return {
        label: 'Feet', value: feet, unit: '× hip width',
        A: wrY > shY && (!T.jackLegsOn || feet < T.jackLegs * 0.8),
        B: wrY < lm[P.NOSE].y && legsOk,
        hint: '',
      };
    },
  },
  doubleunder: { name: 'Double-unders', color: '#6b7480', manual: true, tip: 'Tap +1, or Done when the set is finished.' },
  run: { name: 'Run', color: '#6b7480', manual: true, tip: 'Tap Done when you get back from the run.' },
  other: { name: 'Other', color: '#6b7480', manual: true, tip: 'Counted by tapping +1 or Done.' },
};
export const CAMERA_MOVES = Object.keys(MOVES).filter(k => !MOVES[k].manual);

// Exponential smoothing of landmarks to cut jitter.
export class Smoother {
  constructor(alpha = 0.55) { this.alpha = alpha; this.prev = null; }
  reset() { this.prev = null; }
  push(lm) {
    if (!this.prev || this.prev.length !== lm.length) {
      this.prev = lm.map(p => ({ ...p }));
    } else {
      const a = this.alpha;
      this.prev = lm.map((p, i) => {
        const q = this.prev[i];
        return { x: a * p.x + (1 - a) * q.x, y: a * p.y + (1 - a) * q.y, z: p.z, visibility: p.visibility };
      });
    }
    return this.prev;
  }
}

// State machine: must reach A, then B, then A again (for countOn A) — full range of motion.
export class RepDetector {
  constructor(kind, level = 'standard', { frames = 2, minGapMs = 350 } = {}) {
    this.kind = kind;
    this.def = MOVES[kind] || MOVES.other;
    this.T = LEVELS[level] || LEVELS.standard;
    this.frames = frames;
    this.minGapMs = minGapMs;
    this.reset();
  }
  reset() { this.phase = null; this.nA = 0; this.nB = 0; this.lastRep = -Infinity; }
  // aspect = video width / height, so angles are measured in real proportions.
  update(raw, t, aspect = 1) {
    if (this.def.manual) return { rep: false, phase: null, visible: true, hint: '' };
    const lm = raw.map(p => ({ x: p.x * aspect, y: p.y, visibility: p.visibility }));
    const m = this.def.measure(lm, this.T);
    if (!m) return { rep: false, phase: this.phase, visible: false, hint: 'Step back so your whole body is in view' };
    this.nA = m.A ? this.nA + 1 : 0;
    this.nB = m.B ? this.nB + 1 : 0;
    let rep = false;
    if (this.nA >= this.frames && this.phase !== 'A') {
      if (this.phase === 'B' && this.def.countOn === 'A') rep = true;
      this.phase = 'A';
    } else if (this.nB >= this.frames && (this.phase === 'A' || (this.phase === null && this.def.startFromB))) {
      if (this.phase === 'A' && this.def.countOn === 'B') rep = true;
      this.phase = 'B';
    }
    if (rep) {
      if (t - this.lastRep < this.minGapMs) rep = false;
      else this.lastRep = t;
    }
    return { rep, phase: this.phase, visible: true, label: m.label, value: m.value, unit: m.unit || '°', hint: m.hint };
  }
}

/* ---------------- workouts ---------------- */

const s = (key, reps, label) => (label ? { key, reps, label } : { key, reps });
// 21-15-9 style: every rep count applied to each movement in turn.
export const ladder = (counts, keys) => counts.flatMap(n => keys.map(k => s(k, n)));

export const WORKOUTS = [
  { id: 'cindy', name: 'Cindy', format: 'amrap', minutes: 20, seq: [s('pullup', 5), s('pushup', 10), s('squat', 15)],
    desc: '20-min AMRAP · 5 pull-ups · 10 push-ups · 15 air squats' },
  { id: 'fran', name: 'Fran', format: 'fortime', minutes: 10, seq: ladder([21, 15, 9], ['thruster', 'pullup']),
    desc: '21-15-9 for time · thrusters (43/29 kg) · pull-ups · 10-min cap' },
  { id: 'angie', name: 'Angie', format: 'fortime', minutes: 30,
    seq: [s('pullup', 100), s('pushup', 100), s('situp', 100), s('squat', 100)],
    desc: 'For time · 100 pull-ups · 100 push-ups · 100 sit-ups · 100 squats' },
  { id: 'chelsea', name: 'Chelsea', format: 'emom', minutes: 30, emomMode: 'all',
    seq: [s('pullup', 5), s('pushup', 10), s('squat', 15)],
    desc: 'EMOM 30 · 5 pull-ups · 10 push-ups · 15 air squats every minute' },
  { id: 'annie', name: 'Annie', format: 'fortime', minutes: 20, seq: ladder([50, 40, 30, 20, 10], ['doubleunder', 'situp']),
    desc: '50-40-30-20-10 for time · double-unders (tap) · sit-ups' },
  { id: 'murph', name: 'Murph', format: 'fortime', minutes: 70,
    seq: [s('run', 1, 'Run 1 mile'), s('pullup', 100), s('pushup', 200), s('squat', 300), s('run', 1, 'Run 1 mile')],
    desc: 'For time · 1-mile run · 100 pull-ups · 200 push-ups · 300 squats · 1-mile run (unpartitioned)' },
  { id: 'burpees100', name: '100 Burpees', format: 'fortime', minutes: 15, seq: [s('burpee', 100)],
    desc: '100 burpees for time · 15-min cap' },
  { id: 'jacks-squats', name: 'Leg Burner', format: 'emom', minutes: 12, emomMode: 'alternate',
    seq: [s('lunge', 20), s('squat', 20), s('jack', 40)],
    desc: 'EMOM 12, alternating · 20 lunges · 20 air squats · 40 jumping jacks' },
];

export const FORMAT_NAMES = { amrap: 'AMRAP', fortime: 'For time', emom: 'EMOM' };
export const stepName = st => st.label || (MOVES[st.key] || MOVES.other).name;

export function describe(def) {
  if (def.desc) return def.desc;
  const parts = def.seq.map(st => `${st.reps} ${stepName(st).toLowerCase()}`).join(' · ');
  if (def.format === 'amrap') return `${def.minutes}-min AMRAP · ${parts}`;
  if (def.format === 'emom') return `EMOM ${def.minutes}${def.emomMode === 'alternate' ? ', alternating' : ''} · ${parts}`;
  const r = def.rounds > 1 ? `${def.rounds} rounds for time` : 'For time';
  return `${r} · ${parts} · ${def.minutes}-min cap`;
}

export function clock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

// Workout bookkeeping. Every rep and every EMOM minute change is an event, so undo is a replay.
export class Session {
  constructor(def) {
    this.def = def;
    this.events = [];
    this.flat = def.format === 'fortime'
      ? Array.from({ length: Math.max(1, def.rounds || 1) }, () => def.seq).flat() : def.seq;
    this.reset();
  }
  reset() {
    this.idx = 0; this.reps = 0; this.total = 0; this.splits = [];
    this.done = false; this.doneAt = null;
    this.minute = 0; this.minutesDone = 0; this.resting = false; this.missed = [];
  }
  get format() { return this.def.format; }
  get blocks() { return this.def.emomMode === 'alternate' ? this.def.seq.map(x => [x]) : [this.def.seq]; }
  // The list of steps that idx walks through right now.
  get list() {
    if (this.format === 'emom') return this.blocks[this.minute % this.blocks.length];
    return this.format === 'fortime' ? this.flat : this.def.seq;
  }
  get step() {
    const L = this.list;
    return this.format === 'amrap' ? L[this.idx % L.length] : L[Math.min(this.idx, L.length - 1)];
  }
  get roundLen() { return this.format === 'emom' ? this.list.length : this.def.seq.length; }
  get rounds() { return this.format === 'emom' ? this.minutesDone : Math.floor(this.idx / this.def.seq.length); }
  get totalRounds() { return this.format === 'fortime' ? this.flat.length / this.def.seq.length : null; }
  // Reps done in the current round (AMRAP "+ reps").
  get partial() {
    const L = this.def.seq, k = this.idx % L.length;
    return L.slice(0, k).reduce((n, x) => n + x.reps, 0) + this.reps;
  }
  // Steps of the current round with how many reps are done in each.
  chunk() {
    if (this.format === 'emom') {
      return this.list.map((st, i) => ({ ...st, done: this.resting || i < this.idx ? st.reps : i === this.idx ? this.reps : 0 }));
    }
    const len = this.def.seq.length;
    if (this.format === 'amrap') {
      const k = this.idx % len; // AMRAP's idx keeps counting across rounds
      return this.def.seq.map((st, i) => ({ ...st, done: i < k ? st.reps : i === k ? this.reps : 0 }));
    }
    const src = this.flat;
    let base = Math.floor(this.idx / len) * len;
    if (this.format === 'fortime' && this.done) base = this.flat.length - len;
    return src.slice(base, base + len).map((st, i) => ({
      ...st, done: base + i < this.idx ? st.reps : base + i === this.idx ? this.reps : 0,
    }));
  }
  get remainingInStep() { return this.step.reps - this.reps; }

  add(t = 0) {
    if (this.done || this.resting) return null;
    this.events.push({ type: 'rep', t });
    return this._rep(t);
  }
  // Fill the rest of the current movement (manual movements, or reps the camera missed).
  complete(t = 0) {
    let ev = null;
    const n = this.remainingInStep;
    for (let i = 0; i < n; i++) ev = this.add(t);
    return ev;
  }
  _rep(t) {
    this.reps++; this.total++;
    if (this.reps < this.step.reps) return 'rep';
    this.reps = 0; this.idx++;
    const len = this.def.seq.length;
    if (this.format === 'amrap') {
      if (this.idx % len === 0) { this.splits.push(t); return 'round'; }
      return 'move';
    }
    if (this.format === 'fortime') {
      if (this.idx >= this.flat.length) { this.done = true; this.doneAt = t; this.splits.push(t); return 'done'; }
      if (this.idx % len === 0) { this.splits.push(t); return 'round'; }
      return 'move';
    }
    if (this.idx >= this.list.length) {
      this.resting = true; this.minutesDone++; this.splits.push(t - this.minute * 60000);
      return 'minute';
    }
    return 'move';
  }
  // EMOM: a new minute started. Returns true if the previous minute's work was finished.
  tick(minute) {
    if (this.format !== 'emom' || minute <= this.minute) return null;
    this.events.push({ type: 'tick', minute });
    return this._tick(minute);
  }
  _tick(m) {
    const ok = this.resting;
    if (!ok) this.missed.push(this.minute);
    this.minute = m; this.idx = 0; this.reps = 0; this.resting = false;
    return ok;
  }
  undo() {
    let i = this.events.length - 1;
    while (i >= 0 && this.events[i].type !== 'rep') i--;
    if (i < 0) return false;
    if (this.events.slice(i + 1).some(e => e.type === 'tick')) return false; // EMOM: only within this minute
    this.events.splice(i, 1);
    const evs = this.events;
    this.reset();
    for (const e of evs) { if (e.type === 'rep') this._rep(e.t); else this._tick(e.minute); }
    return true;
  }
  get score() {
    if (this.format === 'amrap') return `${this.rounds} + ${this.partial}`;
    if (this.format === 'fortime') return this.done ? clock(this.doneAt) : `${this.total} reps`;
    return `${this.minutesDone}/${this.def.minutes}`;
  }
  // Higher is better, for finding personal bests.
  get rank() {
    if (this.format === 'fortime') return this.done ? 1e9 - this.doneAt : this.total;
    if (this.format === 'emom') return this.minutesDone * 1e5 + this.total;
    return this.total;
  }
  // AMRAP / For time: time per round. EMOM: work time within each completed minute.
  roundTimes() {
    if (this.format === 'emom') return this.splits.slice();
    return this.splits.map((t, i) => t - (i ? this.splits[i - 1] : 0));
  }
}
