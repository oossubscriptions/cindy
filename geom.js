// Shared pose geometry. Landmarks are MediaPipe Pose points ({x, y, visibility}), x already scaled
// by the video's aspect ratio so angles come out in real proportions.

// MediaPipe Pose landmark indices, as [left, right] pairs.
export const P = {
  NOSE: 0, MOUTH: [9, 10],
  SH: [11, 12], EL: [13, 14], WR: [15, 16],
  HIP: [23, 24], KN: [25, 26], AN: [27, 28],
};

export const MIN_VIS = 0.5;

export function angle(a, b, c) {
  const ab = Math.atan2(a.y - b.y, a.x - b.x);
  const cb = Math.atan2(c.y - b.y, c.x - b.x);
  const d = Math.abs((ab - cb) * 180 / Math.PI);
  return d > 180 ? 360 - d : d;
}
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const vis = p => (p ? (p.visibility ?? 1) : 0);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(vis(a), vis(b)) });
export const seen = (lm, ...idx) => idx.every(i => vis(lm[i]) >= MIN_VIS);
// Angle of the a→b line from horizontal, 0..90 degrees.
export const tilt = (a, b) => Math.atan2(Math.abs(a.y - b.y), Math.abs(a.x - b.x)) * 180 / Math.PI;
