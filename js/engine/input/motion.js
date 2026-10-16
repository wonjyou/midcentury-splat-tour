// Phone and tablet orientation as the head: turn or tilt the device to look
// around, like a window you hold. Angles are relative to the pose the device
// had when motion started (or was recentred).

import { OneEuro, clamp, zeroPose } from './filters.js';

const DEG = Math.PI / 180;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export class MotionInput {
  constructor({ yawGain = 1.0, pitchGain = 0.8 } = {}) {
    this.gain = { yaw: yawGain, pitch: pitchGain };
    this.active = false;
    this.target = zeroPose();
    this.base = null;
    this.filters = { yaw: new OneEuro(0.8, 0.2), pitch: new OneEuro(0.8, 0.2) };
    this.onOrient = (e) => this.handle(e);
  }

  static supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  // Must be called from a user gesture on iOS (it asks for permission).
  async start() {
    if (!MotionInput.supported()) throw Object.assign(new Error('No motion sensors'), { name: 'NotSupportedError' });
    const D = window.DeviceOrientationEvent;
    if (typeof D.requestPermission === 'function') {
      const r = await D.requestPermission();
      if (r !== 'granted') throw Object.assign(new Error('Motion permission denied'), { name: 'NotAllowedError' });
    }
    this.recenter();
    window.addEventListener('deviceorientation', this.onOrient);
    // Desktops expose the event but never fire it with data.
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 1200);
      const once = (e) => { if (e.alpha === null && e.beta === null) return; clearTimeout(t); window.removeEventListener('deviceorientation', once); resolve(true); };
      window.addEventListener('deviceorientation', once);
    });
    if (!ok) { this.stop(); throw Object.assign(new Error('No motion data'), { name: 'NotSupportedError' }); }
    this.active = true;
  }

  stop() {
    window.removeEventListener('deviceorientation', this.onOrient);
    this.active = false;
    this.target = zeroPose();
  }

  dispose() { this.stop(); }

  recenter() {
    this.base = null;
    for (const f of Object.values(this.filters)) f.reset();
  }

  handle(e) {
    if (e.alpha === null || e.beta === null) return;
    const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    // Portrait: alpha turns, beta tilts. Landscape: gamma takes over the tilt.
    const yawDeg = e.alpha;
    const tiltDeg = angle === 90 ? -e.gamma : angle === 270 || angle === -90 ? e.gamma : e.beta;
    if (!this.base) { this.base = { yaw: yawDeg, tilt: tiltDeg }; return; }
    const t = performance.now() / 1000;
    // Turning the device to the left increases alpha, which turns the view left.
    const yaw = this.filters.yaw.filter(wrap(yawDeg - this.base.yaw) * DEG, t);
    const pitch = this.filters.pitch.filter(wrap(tiltDeg - this.base.tilt) * DEG, t);
    this.target.yaw = clamp(yaw * this.gain.yaw, -1.4, 1.4);
    this.target.pitch = clamp(pitch * this.gain.pitch, -0.5, 0.5);
    this.target.x = clamp(-this.target.yaw * 0.25, -0.4, 0.4);
  }

  update() {}
}
