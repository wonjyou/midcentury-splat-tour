// Parses and frames a captured splat scene off the main thread. The raw
// capture stays here so flip/turn corrections can re-frame it without
// re-reading the file.
import { parseCapture, autoBasis, frameFor, encodeColors, transformCapture, defaultStops } from './capture.js';

let raw = null, basis = null, colors = null, label = '';

const progress = (p, text) => self.postMessage({ type: 'progress', p, label: text });

async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the scene (HTTP ${res.status}).`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) return new Blob([out.subarray(0, got), value]).arrayBuffer(); // length lied
    out.set(value, got);
    got += value.length;
    progress((got / total) * 0.7, `Downloading ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
  }
  return out.buffer.slice(0, got);
}

function emit(opts) {
  let frame = frameFor(raw, basis, opts);
  let scene = transformCapture(raw, frame);
  let stops = defaultStops(scene.positions, raw.alpha, frame, label);
  if (stops.object) {
    // Nowhere to stand inside it: it's an object, so re-frame it at object size.
    frame = frameFor(raw, basis, { ...opts, object: true });
    scene = transformCapture(raw, frame);
    stops = defaultStops(scene.positions, raw.alpha, frame, label);
  }
  scene.colors = colors.slice();
  self.postMessage({
    type: 'done',
    scene,
    meta: { name: label, count: raw.count, metric: frame.metric, scale: frame.k, height: frame.bounds.h, stops: [...stops] },
  }, [scene.positions.buffer, scene.covariances.buffer, scene.colors.buffer, scene.normals.buffer, scene.extra.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      label = (msg.name || '').replace(/\.(ply|splat)$/i, '');
      const buffer = msg.buffer || await fetchWithProgress(msg.url);
      progress(0.75, 'Reading splats');
      raw = parseCapture(buffer, msg.name || '');
      progress(0.85, 'Levelling the capture');
      basis = autoBasis(raw);
      progress(0.92, 'Developing');
      colors = encodeColors(raw, msg.exposure);
      emit(msg.options);
    } else if (msg.type === 'reframe' && raw) {
      emit(msg.options);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
