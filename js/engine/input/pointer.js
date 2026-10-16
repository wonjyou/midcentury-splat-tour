// The pointer as a stand-in for the head.
//
// Mouse and pen: hovering anywhere on the page aims the view at the pointer
// (absolute), with a little sideways parallax. Touch: dragging sideways on the
// surface turns the view and it stays where you leave it. Vertical swipes are
// left to the page so it still scrolls (pair with `touch-action: pan-y`).

import { clamp, zeroPose } from './filters.js';

export class PointerInput {
  constructor(surface, { yawRange = 0.62, pitchRange = 0.22, parallax = { x: 0.35, y: 0.25 }, dragGain = 2.2, maxDragYaw = 1.25 } = {}) {
    this.surface = surface;
    this.opts = { yawRange, pitchRange, parallax, dragGain, maxDragYaw };
    this.target = zeroPose();
    this.lastInput = -Infinity;
    this.drag = null;
    this.touched = false;   // a touch device: no hover, so no idle drift once used

    this.onMove = (e) => {
      if (e.pointerType === 'touch') return this.onDragMove(e);
      const r = surface.getBoundingClientRect();
      const nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1.2, 1.2);
      const ny = clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1.2, 1.2);
      const o = this.opts;
      this.target.yaw = -nx * o.yawRange;
      this.target.pitch = ny * o.pitchRange;
      this.target.x = -nx * o.parallax.x;
      this.target.y = -ny * o.parallax.y;
      this.target.z = 0;
      this.lastInput = performance.now();
    };
    this.onDown = (e) => {
      if (e.pointerType !== 'touch') return;
      this.touched = true;
      this.drag = { id: e.pointerId, x: e.clientX, yaw: this.target.yaw };
      this.lastInput = performance.now();
    };
    this.onUp = (e) => { if (this.drag && e.pointerId === this.drag.id) this.drag = null; };

    window.addEventListener('pointermove', this.onMove, { passive: true });
    surface.addEventListener('pointerdown', this.onDown, { passive: true });
    window.addEventListener('pointerup', this.onUp, { passive: true });
    window.addEventListener('pointercancel', this.onUp, { passive: true });
  }

  onDragMove(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const o = this.opts, w = this.surface.getBoundingClientRect().width || 1;
    // Drag the room: finger right swings the view left.
    const yaw = clamp(this.drag.yaw + ((e.clientX - this.drag.x) / w) * o.dragGain, -o.maxDragYaw, o.maxDragYaw);
    this.target.yaw = yaw;
    this.target.x = (yaw / o.maxDragYaw) * o.parallax.x;
    this.target.pitch = 0;
    this.target.y = 0;
    this.lastInput = performance.now();
  }

  get idle() {
    return !this.drag && performance.now() - this.lastInput > 3500;
  }

  // Nobody is steering: drift slowly so the parallax still shows. Touch users
  // who have turned the view keep it.
  update(t, allowDrift) {
    if (!allowDrift || !this.idle || this.touched) return;
    this.target.yaw = 0.32 * Math.sin(t * 0.21);
    this.target.pitch = 0.06 * Math.sin(t * 0.17 + 1.2);
    this.target.x = 0.4 * Math.sin(t * 0.33);
    this.target.y = 0.15 * Math.sin(t * 0.27 + 0.5);
    this.target.z = 0;
  }

  dispose() {
    window.removeEventListener('pointermove', this.onMove);
    this.surface.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }
}
