// Rhythm counting: counts any repeated movement and, in Auto-detect, names it.
// Finds the body signal with the biggest steady swing over the last few seconds and counts its cycles.
// Needs 3 consistent cycles before it reports, then counts the whole set from its start.
import { P, angle, dist, mid, seen, tilt } from './geom.js';

// Body signals, each scaled by torso length (S) or by 90° for angles, with the smallest swing that counts.
const SIGNALS = {
  wristY: 0.35,   // hands up/down relative to the shoulders
  wristX: 0.35,   // hands apart/together
  elbow: 0.5,     // elbow bend
  armLift: 0.5,   // upper arm raised from the side
  hip: 0.45,      // hip fold (hinges, toe touches, leg raises)
  knee: 0.5,      // knee bend
  hipY: 0.25,     // hips up/down
  shY: 0.25,      // shoulders up/down
  hipX: 0.5,      // hips side to side
  lean: 0.3,      // torso leaning sideways
  twist: 0.25,    // shoulders turning (their apparent width changes)
  kneeDrive: 0.35, // a knee coming up towards the chest (either leg)
  heelLift: 0.35, // a heel coming up towards the hips (either leg)
  kneeGap: 0.25,  // knees opening and closing
  legSpread: 0.5, // feet apart/together
  rise: 0.08,     // the whole body rising a little on straight legs (calf raises)
};

export class PeriodicCounter {
  constructor({ windowMs = 10000, classify = false } = {}) {
    this.windowMs = windowMs; this.classifyOn = classify; this.buf = []; this.reset();
  }
  reset() { this.sig = null; this.state = null; this.cycles = []; this.confirmed = false; this.key = null; }

  features(lm) {
    if (!seen(lm, ...P.SH, ...P.HIP)) return null;
    const sh = mid(lm[11], lm[12]), hip = mid(lm[23], lm[24]);
    const S = dist(sh, hip) || 0.2;
    const s = {
      hipY: hip.y / S, shY: sh.y / S, hipX: hip.x / S, rise: (hip.y + sh.y) / 2 / S,
      lean: (sh.x - hip.x) / S, twist: Math.abs(lm[11].x - lm[12].x) / S,
    };
    const p = { tilt: tilt(sh, hip) };
    if (seen(lm, ...P.WR)) {
      const wr = mid(lm[15], lm[16]);
      s.wristY = (wr.y - sh.y) / S; s.wristX = Math.abs(lm[15].x - lm[16].x) / S;
      p.overhead = wr.y < lm[P.NOSE].y;
      p.wristBelowSh = wr.y > sh.y;
      p.support = wr.y > sh.y + 0.5 * S;                       // hands on the floor under the shoulders
      p.wristChest = wr.y > sh.y - 0.15 * S && wr.y < sh.y + 0.7 * S;
    }
    if (seen(lm, ...P.EL)) {
      const el = mid(lm[13], lm[14]);
      s.armLift = (angle(lm[23], lm[11], lm[13]) + angle(lm[24], lm[12], lm[14])) / 180;
      p.elbowsHigh = el.y < sh.y + 0.1 * S;
      p.elbowsUp = el.y < sh.y - 0.1 * S;
      if (seen(lm, ...P.WR)) { p.elbowDeg = (angle(lm[11], lm[13], lm[15]) + angle(lm[12], lm[14], lm[16])) / 2; s.elbow = p.elbowDeg / 90; }
    }
    if (seen(lm, ...P.KN)) {
      s.hip = (angle(lm[11], lm[23], lm[25]) + angle(lm[12], lm[24], lm[26])) / 180;
      s.kneeDrive = Math.min(dist(lm[25], sh), dist(lm[26], sh)) / S;
      s.kneeGap = dist(lm[25], lm[26]) / S;
      p.kneeUnderHips = lm[25].y > hip.y + 0.5 * S || lm[26].y > hip.y + 0.5 * S;
      if (seen(lm, ...P.AN)) {
        p.kneeDeg = (angle(lm[23], lm[25], lm[27]) + angle(lm[24], lm[26], lm[28])) / 2;
        s.knee = p.kneeDeg / 90;
        s.heelLift = Math.min(dist(lm[27], hip), dist(lm[28], hip)) / S;
        s.legSpread = Math.abs(lm[27].x - lm[28].x) / S;
        p.handsNearFeet = seen(lm, ...P.WR) && Math.max(lm[15].y, lm[16].y) > (lm[25].y + lm[27].y) / 2;
      }
    }
    return { s, p };
  }

  range(k) {
    const v = this.buf.map(b => b.s[k]).filter(x => x != null);
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  }

  update(lm, t) {
    const f = this.features(lm);
    if (!f) return { reps: 0 };
    this.buf.push({ t, ...f });
    while (this.buf.length && t - this.buf[0].t > this.windowMs) this.buf.shift();
    if (t - this.buf[0].t < 1500) return { reps: 0 };
    const share = fn => this.buf.filter(b => fn(b.p)).length / this.buf.length;
    let best = null, bestScore = 1, lo = 0, hi = 0;
    for (const [k, need] of Object.entries(SIGNALS)) {
      const vals = this.buf.map(b => b.s[k]).filter(v => v != null);
      if (vals.length < this.buf.length * 0.8) continue;
      const mn = Math.min(...vals), mx = Math.max(...vals), score = (mx - mn) / need;
      if (k === 'rise') {
        // Calf raises only: small lift on straight legs while standing, nothing bigger going on.
        if (share(p => p.kneeDeg == null || p.kneeDeg > 160) < 0.9 || share(p => p.tilt > 60) < 0.8 || this.range('hipY') > 0.3 || this.range('shY') > 0.3) continue;
      }
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
    return { reps, key: this.key };
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
    if (gap != null && (gap < 250 || gap > 8000 || (lastGap && (gap > lastGap * 2.2 || gap < lastGap / 2.2)))) {
      this.cycles = [t]; this.confirmed = false;
      return 0;
    }
    this.cycles.push(t);
    if (this.confirmed) return 1;
    if (this.cycles.length >= 3) {
      this.confirmed = true;
      if (this.classifyOn) this.key = this.classify();
      return 'confirm';
    }
    return 0;
  }

  // Name the movement from which signal moves and the posture around it. Returns a MOVES key.
  classify() {
    const sig = this.sig, B = this.buf, r = k => this.range(k);
    const share = fn => B.filter(b => fn(b.p)).length / B.length;
    const gaps = this.cycles.slice(1).map((c, i) => c - this.cycles[i]).sort((a, b) => a - b);
    const period = gaps[Math.floor(gaps.length / 2)] || 1000;
    const elbows = B.map(b => b.p.elbowDeg).filter(v => v != null);
    const minElbow = elbows.length ? Math.min(...elbows) : 180;
    const lying = share(p => p.tilt < 35) > 0.6;
    const standing = share(p => p.tilt > 60) > 0.6;
    const armsStraight = share(p => p.elbowDeg != null && p.elbowDeg > 150) > 0.7;
    const kneesStraight = share(p => p.kneeDeg == null || p.kneeDeg > 150) > 0.7;
    const kneesBent = share(p => p.kneeDeg != null && p.kneeDeg < 140) > 0.6;
    const arms = ['wristY', 'wristX', 'elbow', 'armLift'].includes(sig);

    if (lying) {
      const support = share(p => p.support) > 0.7;
      if (support && share(p => p.kneeUnderHips) > 0.6) return 'kickbacks';    // on hands and knees
      if (support && armsStraight && ['kneeDrive', 'knee', 'hip', 'heelLift', 'kneeGap'].includes(sig)) return 'climbers';
      if (sig === 'kneeGap' && !support) return 'clamshells';
      if (['hipY', 'hip', 'shY'].includes(sig) && kneesBent) return 'bridges';
      if (['hip', 'kneeDrive', 'heelLift', 'knee'].includes(sig) && kneesStraight) return 'legraises';
      return 'other';
    }
    // Standing leg work, torso still: name it by what the legs do.
    const torsoStill = r('shY') < 0.2 && r('lean') < 0.2;
    if (standing && torsoStill && ['kneeGap', 'kneeDrive', 'hip', 'knee', 'heelLift', 'legSpread', 'hipX'].includes(sig)) {
      if (r('kneeDrive') > 0.35) return period < 700 ? 'highknees' : 'march';
      if (r('heelLift') > 0.35) return 'buttkicks';
      if (r('legSpread') > 0.3 || r('hipX') > 0.5) return 'latsteps';
    }
    const folding = r('shY') > 0.5 && r('hipY') < 0.3; // shoulders go down and up, hips stay
    if (sig === 'hip' || (folding && ['shY', 'lean', 'kneeDrive', 'wristY'].includes(sig))) return share(p => p.handsNearFeet) > 0.15 ? 'toetouches' : 'hinge';
    if (sig === 'kneeDrive') return period < 700 ? 'highknees' : 'march';
    if (sig === 'heelLift') return 'buttkicks';
    if (sig === 'hipX' || sig === 'legSpread') return 'latsteps';
    if (sig === 'rise') return 'calfraises';
    if (sig === 'lean') return 'sidebends';
    if (sig === 'twist') return 'twists';
    if (arms) {
      const overhead = share(p => p.overhead) > 0.15;
      if (share(p => p.elbowsUp) > 0.7 && r('elbow') > 0.5) return 'triceps';
      if (overhead && armsStraight && r('armLift') > 1.2) return 'armcircles';
      if (overhead) return 'press';
      if (armsStraight && r('armLift') > 0.6) return r('wristX') > 0.5 ? 'latraise' : 'frontraise';
      if (sig === 'wristX' && armsStraight) return 'pullapart';
      if (r('wristY') > 0.35 && share(p => p.elbowsHigh) > 0.15) return 'uprightrow';
      if (share(p => p.elbowsHigh) > 0.6) return 'facepull';
      if (r('wristY') > 0.5) return minElbow < 65 ? 'curl' : 'pushdown';
      if (share(p => p.wristChest) > 0.7) return 'row';
    }
    return 'other';
  }
}
