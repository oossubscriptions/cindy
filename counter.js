// Pure logic: rep detection from pose landmarks + Cindy workout bookkeeping.
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
  strict:   { squatDown: 95,  squatUp: 165, pushDown: 90,  pushUp: 155, pullHang: 150, chinTol: -0.05, hipKneeTol: 0.0 },
  standard: { squatDown: 105, squatUp: 160, pushDown: 100, pushUp: 150, pullHang: 140, chinTol: 0.1,  hipKneeTol: 0.15 },
  lenient:  { squatDown: 120, squatUp: 150, pushDown: 115, pushUp: 140, pullHang: 125, chinTol: 0.3,  hipKneeTol: 0.3 },
};

export function angle(a, b, c) {
  const ab = Math.atan2(a.y - b.y, a.x - b.x);
  const cb = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs((ab - cb) * 180 / Math.PI);
  return d > 180 ? 360 - d : d;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vis = p => (p ? (p.visibility ?? 1) : 0);

// Pick the body side (0 = left, 1 = right) whose joints are most visible.
function bestSide(lm, groups) {
  const score = s => Math.min(...groups.map(g => vis(lm[g[s]])));
  const l = score(0), r = score(1);
  return l >= r ? { s: 0, v: l } : { s: 1, v: r };
}

// Each movement has two positions: A (start / lockout) and B (the other end of the range).
// countOn says which arrival completes the rep.
export const MOVES = {
  pullup: {
    countOn: 'B', // chin over the bar completes the rep
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.EL, P.WR]);
      if (v < MIN_VIS) return null;
      const sh = lm[P.SH[s]], el = lm[P.EL[s]], wr = lm[P.WR[s]];
      const elbow = angle(sh, el, wr);
      const upperArm = dist(sh, el) || 0.1;
      const mouthY = (lm[P.MOUTH[0]].y + lm[P.MOUTH[1]].y) / 2;
      const handsUp = wr.y < sh.y + 0.5 * upperArm;
      const hanging = wr.y < lm[P.NOSE].y && elbow > T.pullHang;
      const chinOver = handsUp && mouthY < wr.y + T.chinTol * upperArm;
      return {
        label: 'Elbow', value: elbow, A: hanging, B: chinOver,
        hint: handsUp ? '' : 'Hang from the bar with arms straight',
      };
    },
  },
  pushup: {
    countOn: 'A', // back to locked-out arms completes the rep
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.SH, P.EL, P.WR, P.HIP]);
      if (v < MIN_VIS) return null;
      const sh = lm[P.SH[s]], el = lm[P.EL[s]], wr = lm[P.WR[s]], hip = lm[P.HIP[s]];
      const elbow = angle(sh, el, wr);
      const tilt = Math.atan2(Math.abs(sh.y - hip.y), Math.abs(sh.x - hip.x)) * 180 / Math.PI;
      const plank = tilt < 50;
      return {
        label: 'Elbow', value: elbow,
        A: plank && elbow > T.pushUp, B: plank && elbow < T.pushDown,
        hint: plank ? '' : 'Get into a plank, side-on to the camera',
      };
    },
  },
  squat: {
    countOn: 'A', // standing tall completes the rep
    measure(lm, T) {
      const { s, v } = bestSide(lm, [P.HIP, P.KN, P.AN]);
      if (v < MIN_VIS) return null;
      const hip = lm[P.HIP[s]], kn = lm[P.KN[s]], an = lm[P.AN[s]];
      const knee = angle(hip, kn, an);
      const shin = dist(kn, an) || 0.1;
      // Works side-on (knee angle) and facing the camera (hip drops to knee height).
      const hipLow = hip.y >= kn.y - T.hipKneeTol * shin;
      const standing = knee > T.squatUp && hip.y < kn.y - 0.6 * shin;
      return {
        label: 'Knee', value: knee, A: standing, B: knee < T.squatDown || hipLow,
        hint: '',
      };
    },
  },
};

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
    this.def = MOVES[kind];
    this.T = LEVELS[level] || LEVELS.standard;
    this.frames = frames;
    this.minGapMs = minGapMs;
    this.reset();
  }
  reset() { this.phase = null; this.nA = 0; this.nB = 0; this.lastRep = -Infinity; }
  // aspect = video width / height, so angles are measured in real proportions.
  update(raw, t, aspect = 1) {
    const lm = raw.map(p => ({ x: p.x * aspect, y: p.y, visibility: p.visibility }));
    const m = this.def.measure(lm, this.T);
    if (!m) return { rep: false, phase: this.phase, visible: false, hint: 'Step back so your whole body is in view' };
    this.nA = m.A ? this.nA + 1 : 0;
    this.nB = m.B ? this.nB + 1 : 0;
    let rep = false;
    if (this.nA >= this.frames && this.phase !== 'A') {
      if (this.phase === 'B' && this.def.countOn === 'A') rep = true;
      this.phase = 'A';
    } else if (this.nB >= this.frames && this.phase === 'A') {
      this.phase = 'B';
      if (this.def.countOn === 'B') rep = true;
    }
    if (rep) {
      if (t - this.lastRep < this.minGapMs) rep = false;
      else this.lastRep = t;
    }
    return { rep, phase: this.phase, visible: true, label: m.label, value: m.value, hint: m.hint };
  }
}

export const CINDY = {
  minutes: 20,
  moves: [
    { key: 'pullup', name: 'Pull-ups', reps: 5 },
    { key: 'pushup', name: 'Push-ups', reps: 10 },
    { key: 'squat', name: 'Air squats', reps: 15 },
  ],
};

// AMRAP bookkeeping: rounds + reps, with undo and round split times.
export class Workout {
  constructor(cfg = CINDY) {
    this.cfg = cfg;
    this.rounds = 0; this.mi = 0; this.reps = 0;
    this.log = [];    // one entry per rep: elapsed ms
    this.splits = []; // elapsed ms at the end of each round
  }
  get move() { return this.cfg.moves[this.mi]; }
  get perRound() { return this.cfg.moves.reduce((n, m) => n + m.reps, 0); }
  get partial() { return this.cfg.moves.slice(0, this.mi).reduce((n, m) => n + m.reps, 0) + this.reps; }
  get total() { return this.rounds * this.perRound + this.partial; }
  get score() { return `${this.rounds} + ${this.partial}`; }
  // Returns 'rep' | 'move' | 'round' describing what the rep completed.
  add(t = 0) {
    this.log.push(t);
    this.reps++;
    if (this.reps < this.move.reps) return 'rep';
    this.reps = 0;
    this.mi++;
    if (this.mi < this.cfg.moves.length) return 'move';
    this.mi = 0;
    this.rounds++;
    this.splits.push(t);
    return 'round';
  }
  undo() {
    if (!this.log.length) return false;
    this.log.pop();
    if (this.reps > 0) { this.reps--; return true; }
    if (this.mi === 0) { this.rounds--; this.splits.pop(); this.mi = this.cfg.moves.length; }
    this.mi--;
    this.reps = this.move.reps - 1;
    return true;
  }
  roundTimes() { return this.splits.map((t, i) => t - (i ? this.splits[i - 1] : 0)); }
}
