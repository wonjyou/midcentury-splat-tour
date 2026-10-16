// Chooses which input drives the camera and smooths it into one pose offset.
//
// Pointer is always on and is the default. Head (webcam) and motion (device
// orientation) are opt-in; whichever is started takes over until stopped.

import { AXES, zeroPose } from './filters.js';
import { PointerInput } from './pointer.js';
import { HeadInput } from './head.js';
import { MotionInput } from './motion.js';

export class InputController {
  constructor(surface, { pointer, head, motion, drift = true } = {}) {
    this.pointer = new PointerInput(surface, pointer);
    this.head = new HeadInput(head);
    this.motion = new MotionInput(motion);
    this.drift = drift;
    this.value = zeroPose();
  }

  // 'pointer' | 'head' | 'motion'
  get mode() {
    return this.head.active ? 'head' : this.motion.active ? 'motion' : 'pointer';
  }

  async startHead(onStage) {
    this.motion.stop();
    await this.head.start(onStage);
  }

  async startMotion() {
    this.head.stop();
    await this.motion.start();
  }

  stop() {
    this.head.stop();
    this.motion.stop();
  }

  recenter() {
    this.head.recenter();
    this.motion.recenter();
  }

  update(dt, now) {
    const mode = this.mode;
    let target;
    if (mode === 'head') { this.head.update(now); target = this.head.target; }
    else if (mode === 'motion') target = this.motion.target;
    else { this.pointer.update(now / 1000, this.drift); target = this.pointer.target; }
    // Trackers run at camera or sensor rate; this follow fills in the frames
    // between readings so the view glides instead of stepping.
    const k = 1 - Math.exp(-dt * (mode === 'pointer' ? 6 : 9));
    for (const a of AXES) this.value[a] += (target[a] - this.value[a]) * k;
    return this.value;
  }

  dispose() {
    this.pointer.dispose();
    this.head.dispose();
    this.motion.dispose();
  }
}
