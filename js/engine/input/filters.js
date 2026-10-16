// Shared bits for input sources.

export const AXES = ['x', 'y', 'z', 'yaw', 'pitch'];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const zeroPose = () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });

// One Euro filter (Casiez et al. 2012): an adaptive low-pass that smooths hard
// when the signal is steady and opens up when it moves fast, so holding still
// is calm but quick moves don't lag.
export class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  // t in seconds.
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}
