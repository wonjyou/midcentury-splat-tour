// SplatViewer: the one object an app needs. It owns the canvas, renderer,
// depth sorter, tour rig and inputs, runs the frame loop, and adapts quality
// to the device.
//
// Events (EventTarget): 'progress' {p, label}, 'scene' {meta}, 'stop' {index, stop}.

import { SplatRenderer } from './renderer.js';
import { DepthSorter } from './sorter.js';
import { CameraRig, DEFAULT_WINDOW, windowCamera } from './camera.js';
import { InputController } from './input/controller.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// 'low' on phones and small or memory-starved devices, 'high' elsewhere.
export function detectQuality() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 820;
  const weak = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
  return (coarse && small) || weak ? 'low' : 'high';
}

export class SplatViewer extends EventTarget {
  static supported() { return SplatRenderer.supported(); }

  // container: the element the canvas fills and the pointer is measured against.
  // options: canvas, quality ('auto' | 'high' | 'low'), exposure, window
  // (camera overrides, see DEFAULT_WINDOW), input (InputController options).
  constructor(container, options = {}) {
    super();
    this.container = container;
    this.quality = !options.quality || options.quality === 'auto' ? detectQuality() : options.quality;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.canvas = options.canvas || container.appendChild(document.createElement('canvas'));
    if (!options.canvas) {
      // A canvas we made fills the container; the container should be positioned.
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    }
    const low = this.quality === 'low';
    this.renderer = new SplatRenderer(this.canvas, { bloomPasses: low ? 1 : 2 });
    this.renderer.exposure = options.exposure ?? 1.75;
    this.sorter = new DepthSorter((order) => this.renderer.setOrder(order));
    this.rig = new CameraRig({
      reducedMotion: this.reducedMotion,
      onStop: (index, stop) => this.dispatchEvent(new CustomEvent('stop', { detail: { index, stop } })),
    });
    this.input = new InputController(container, { drift: !this.reducedMotion, ...options.input });
    this.window = { ...DEFAULT_WINDOW, ...options.window };

    // Resolution: capped by device, then scaled down if frames run slow.
    this.maxDpr = low ? 1.25 : 1.6;
    this.dprScale = 1;
    this.perf = { ema: 1 / 60, since: 0 };

    this.reveal = { start: 0, origin: [0, 1, 0], to: 30, hold: 31 };
    this.meta = null;
    this.running = false;
    this.visible = true;
    this.last = performance.now();
    this.frame = this.frame.bind(this);

    // Don't render while scrolled away or in a background tab.
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.wake(); }, { threshold: 0.01 });
    this.io.observe(container);
    this.onVisibility = () => this.wake();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // Load a source and show it. Resolves with the scene's meta.
  async show(source, { reveal = true } = {}) {
    const result = await source.load((p, label) => this.dispatchEvent(new CustomEvent('progress', { detail: { p, label } })));
    this.present(result, { reveal });
    return result.meta;
  }

  // Show an already-loaded { scene, meta }. keepStop keeps the tour position
  // (for re-oriented captures).
  present({ scene, meta = {} }, { reveal = true, keepStop = false } = {}) {
    this.renderer.load(scene);
    this.renderer.setLights(meta.lights || null);
    this.sorter.setScene(scene);
    this.meta = meta;
    // 'scene' goes out before the first 'stop', so apps can build their tour UI first.
    this.dispatchEvent(new CustomEvent('scene', { detail: { meta } }));
    this.rig.setAutoplay(false);
    this.rig.setStops(meta.stops || [{ pos: [0, 1.4, 3], target: [0, 1.2, 0] }], keepStop ? this.rig.index : 0);
    const r = meta.reveal || { origin: [0, 1, 0], to: 30, hold: 31 };
    this.reveal = { ...r, start: reveal && !this.reducedMotion ? performance.now() : -1e9 };
    this.wake();
  }

  // Tour controls.
  get stops() { return this.rig.stops; }
  get stopIndex() { return this.rig.index; }
  goTo(i) { this.rig.goTo(i); }
  next() { this.rig.next(); }
  prev() { this.rig.prev(); }
  get autoplay() { return this.rig.autoplay; }
  setAutoplay(on) { this.rig.setAutoplay(on); if (on) this.rig.next(); }

  get exposure() { return this.renderer.exposure; }
  set exposure(v) { this.renderer.exposure = v; }

  wake() {
    if (this.running || !this.meta || !this.visible || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  resize() {
    const dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.dprScale);
    const w = Math.max(1, Math.round(this.container.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  // Nudge the render scale toward a steady frame rate.
  adapt(dt, now) {
    this.perf.ema += (dt - this.perf.ema) * 0.05;
    if (now - this.perf.since < 1000) return;
    this.perf.since = now;
    if (this.perf.ema > 1 / 38 && this.dprScale > 0.7) this.dprScale = Math.max(0.7, this.dprScale - 0.1);
    else if (this.perf.ema < 1 / 56 && this.dprScale < 1) this.dprScale = Math.min(1, this.dprScale + 0.05);
  }

  frame(now) {
    if (!this.visible || document.hidden || this.disposed) { this.running = false; return; }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.adapt(dt, now);
    this.resize();

    const head = this.input.update(dt, now);
    const pose = this.rig.update(dt, now);
    const { view, proj, eye } = windowCamera(pose, head, this.canvas.width / this.canvas.height, this.window);
    this.sorter.request(view);

    const R = this.reveal, k = (now - R.start) / 2600;
    const reveal = k >= 1 ? R.hold : k < 0 ? 0 : 1 + ease(k) * R.to;
    this.renderer.draw({ view, proj, eye, reveal, revealOrigin: R.origin, time: now / 1000 });
    requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.sorter.dispose();
    this.input.dispose();
    this.renderer.dispose();
  }
}
