// Keeps the renderer's draw order front-to-back. Sorting runs in a worker;
// while one sort is in flight, only the newest pending view is kept.

const MOVE_EPSILON = 0.004;

function viewMoved(a, b) {
  if (!b) return true;
  let s = 0;
  for (let i = 0; i < 16; i++) s += Math.abs(a[i] - b[i]);
  return s > MOVE_EPSILON;
}

export class DepthSorter {
  // onOrder(Uint32Array) receives each finished order.
  constructor(onOrder) {
    this.onOrder = onOrder;
    this.worker = null;
  }

  setScene(scene) {
    this.dispose();
    this.worker = new Worker(new URL('./sort-worker.js', import.meta.url));
    const positions = scene.positions.slice();
    this.worker.postMessage({ type: 'init', positions, count: scene.count }, [positions.buffer]);
    this.busy = false;
    this.sorted = null;
    this.pending = null;
    this.worker.onmessage = (e) => {
      this.onOrder(e.data.order);
      this.busy = false;
      if (this.pending) { const v = this.pending; this.pending = null; this.request(v); }
    };
  }

  // Ask for a sort if the view has moved enough since the last one.
  request(view) {
    if (!this.worker) return;
    if (this.busy) { this.pending = view; return; }
    if (!viewMoved(view, this.sorted)) return;
    this.busy = true;
    this.sorted = view;
    this.worker.postMessage({ type: 'sort', view });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}
