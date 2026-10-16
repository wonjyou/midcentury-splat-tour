// Cameras for looking through the screen as if it were a window.
//
// windowCamera() treats the canvas as a fixed rectangle a little in front of a
// pose. Moving the eye (head position) keeps that rectangle where it is, which
// gives an off-axis, asymmetric frustum and real parallax; turning the head
// rotates the whole rig. CameraRig flies between tour stops.

const DEG = Math.PI / 180;

export const DEFAULT_WINDOW = {
  // How far the eye travels, in metres, for a full-scale input offset of 1.
  range: { x: 0.42, y: 0.26, z: 0.5 },
  screenDist: 1.0,       // distance from the eye to the virtual window
  hfov: 70,              // horizontal field of view of a landscape window, degrees
  portraitVfov: 68,      // vertical field of view of a portrait window, degrees
  near: 0.05,
  far: 80,
};

// A stop is { pos: [x,y,z], target: [x,y,z] }; poses are { pos, yaw, pitch }.
// pitchScale < 1 keeps the camera closer to level than the raw look-at.
export function lookAtPose(stop, pitchScale = 0.6) {
  const d = [stop.target[0] - stop.pos[0], stop.target[1] - stop.pos[1], stop.target[2] - stop.pos[2]];
  return {
    pos: stop.pos.slice(),
    yaw: Math.atan2(-d[0], -d[2]),
    pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) * pitchScale,
  };
}

// head: { x, y, z, yaw, pitch } from an input source (positions normalised to
// about [-1, 1], angles in radians). Returns view/projection matrices and the eye.
export function windowCamera(pose, head, aspect, opts = DEFAULT_WINDOW) {
  const o = { ...DEFAULT_WINDOW, ...opts };
  const yaw = pose.yaw + head.yaw, pitch = pose.pitch + head.pitch;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const right = [cy, 0, -sy];
  const back = [sy * cp, -sp, cy * cp];
  const up = [sp * sy, cp, sp * cy];
  const hx = head.x * o.range.x, hy = head.y * o.range.y, hz = head.z * o.range.z;
  const eye = [0, 1, 2].map((k) => pose.pos[k] + right[k] * hx + up[k] * hy + back[k] * hz);
  const d = (v) => v[0] * eye[0] + v[1] * eye[1] + v[2] * eye[2];
  const view = new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -d(right), -d(up), -d(back), 1,
  ]);

  // The window's half extents at screenDist, then the frustum through it from the eye.
  let W, H;
  if (aspect >= 1) { W = Math.tan((o.hfov / 2) * DEG) * o.screenDist; H = W / aspect; }
  else { H = Math.tan((o.portraitVfov / 2) * DEG) * o.screenDist; W = H * aspect; }
  const n = o.near, f = o.far, dist = o.screenDist + hz;
  const l = ((-W - hx) * n) / dist, r = ((W - hx) * n) / dist;
  const b = ((-H - hy) * n) / dist, t = ((H - hy) * n) / dist;
  const proj = new Float32Array(16);
  proj[0] = (2 * n) / (r - l);
  proj[5] = (2 * n) / (t - b);
  proj[8] = (r + l) / (r - l);
  proj[9] = (t + b) / (t - b);
  proj[10] = -(f + n) / (f - n);
  proj[11] = -1;
  proj[14] = (-2 * f * n) / (f - n);
  return { view, proj, eye };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Moves the base pose between tour stops with eased flights, and can play
// through them on a timer. onStop(index, stop) fires whenever the stop changes.
export class CameraRig {
  constructor({ onStop, autoplayInterval = 7, reducedMotion = false } = {}) {
    this.onStop = onStop;
    this.interval = autoplayInterval;
    this.reducedMotion = reducedMotion;
    this.stops = [];
    this.index = 0;
    this.pose = { pos: [0, 1.4, 3], yaw: 0, pitch: 0 };
    this.flight = null;
    this.autoplay = false;
    this.timer = 0;
  }

  setStops(stops, index = 0) {
    this.stops = stops || [];
    this.index = Math.min(index, Math.max(0, this.stops.length - 1));
    if (this.stops.length) this.pose = lookAtPose(this.stops[this.index]);
    this.flight = null;
    this.timer = 0;
    this.onStop?.(this.index, this.stops[this.index]);
  }

  goTo(i) {
    const n = this.stops.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    if (i === this.index && !this.flight) return;
    this.index = i;
    const to = lookAtPose(this.stops[i]);
    const dist = Math.hypot(to.pos[0] - this.pose.pos[0], to.pos[2] - this.pose.pos[2]);
    if (this.reducedMotion) { this.pose = to; this.flight = null; }
    else this.flight = { from: { ...this.pose, pos: this.pose.pos.slice() }, to, start: performance.now(), dur: 1200 + dist * 260 };
    this.timer = 0;
    this.onStop?.(i, this.stops[i]);
  }

  next() { this.goTo(this.index + 1); }
  prev() { this.goTo(this.index - 1); }

  setAutoplay(on) {
    this.autoplay = on;
    this.timer = 0;
  }

  update(dt, now) {
    if (this.flight) {
      const k = Math.min(1, (now - this.flight.start) / this.flight.dur), e = ease(k);
      const { from, to } = this.flight;
      this.pose = {
        pos: [0, 1, 2].map((i) => lerp(from.pos[i], to.pos[i], e)),
        yaw: angleLerp(from.yaw, to.yaw, e),
        pitch: lerp(from.pitch, to.pitch, e),
      };
      if (k >= 1) this.flight = null;
    } else if (this.autoplay) {
      this.timer += dt;
      if (this.timer > this.interval) this.next();
    }
    return this.pose;
  }
}
