// Depth-sorts splats front-to-back for the given view matrix with a 16-bit
// counting sort. Runs off the main thread so the camera never stutters.

let positions = null;
let count = 0;
let depths, keys;
const BUCKETS = 65536;
const counts = new Uint32Array(BUCKETS);
const starts = new Uint32Array(BUCKETS);

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    positions = msg.positions;
    count = msg.count;
    depths = new Float32Array(count);
    keys = new Uint32Array(count);
    return;
  }
  if (msg.type !== 'sort' || !positions) return;

  const v = msg.view;
  // Distance in front of the camera = -(third row of the view matrix · p).
  const a = -v[2], b = -v[6], c = -v[10], d = -v[14];
  let min = Infinity, max = -Infinity;
  for (let i = 0, j = 0; i < count; i++, j += 3) {
    const z = a * positions[j] + b * positions[j + 1] + c * positions[j + 2] + d;
    depths[i] = z;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  const scale = (BUCKETS - 1) / Math.max(max - min, 1e-6);
  counts.fill(0);
  for (let i = 0; i < count; i++) {
    const k = ((depths[i] - min) * scale) | 0;
    keys[i] = k;
    counts[k]++;
  }
  starts[0] = 0;
  for (let i = 1; i < BUCKETS; i++) starts[i] = starts[i - 1] + counts[i - 1];
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[starts[keys[i]]++] = i;
  self.postMessage({ type: 'order', order, id: msg.id }, [order.buffer]);
};
