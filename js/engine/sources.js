// Scene sources: anything with `load(onProgress) → Promise<{ scene, meta }>`.
//
// scene follows the contract in format.js. meta may carry:
//   stops   [{ pos, target, ...anything the app wants (name, blurb) }]
//   lights  light rig for specular highlights (see SplatRenderer.setLights)
//   reveal  { origin, to, hold } for the load-in sweep
//   label   a display name
//
// Results are cached, so showing a source again doesn't rebuild it.

import { sceneTransferables } from './format.js';

// Runs a module worker that builds a scene. The worker receives
// { type: 'build', ...message } and replies with
// { type: 'progress', p, label }, then { type: 'done', scene, meta? }
// (or { type: 'error', message }).
export function workerSource(workerUrl, { message = {}, meta = {} } = {}) {
  let cached = null;
  return {
    meta,
    load(onProgress) {
      if (cached) return cached;
      cached = new Promise((resolve, reject) => {
        const w = new Worker(workerUrl, { type: 'module' });
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') onProgress?.(m.p, m.label);
          else if (m.type === 'done') { w.terminate(); resolve({ scene: m.scene, meta: { ...meta, ...m.meta } }); }
          else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
        };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The scene worker failed.')); };
        w.postMessage({ type: 'build', ...message });
      });
      cached.catch(() => { cached = null; });
      return cached;
    },
  };
}

// Helper for builder workers: wire a synchronous build(progress, message)
// function into the worker protocol above.
export function serveBuilder(build) {
  self.onmessage = (e) => {
    if (e.data.type !== 'build') return;
    try {
      const scene = build((p, label) => self.postMessage({ type: 'progress', p, label }), e.data);
      self.postMessage({ type: 'done', scene }, sceneTransferables(scene));
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  };
}

// A captured 3DGS scene: { file } (a File/Blob) or { url } to a .ply or .splat.
// options: { flip, turn } corrections; exposure matches captured colours to the
// renderer's exposure. reframe(options) re-orients without re-reading the file.
export function captureSource({ file, url, options = { flip: false, turn: 0 }, exposure = 1.75 }) {
  const name = file ? file.name : decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'scene');
  const label = name.replace(/\.(ply|splat)$/i, '');
  let worker = null, pending = null, cached = null, onProgress = null;
  let current = { ...options };

  const settle = (fn, value) => { const p = pending; pending = null; p?.[fn](value); };
  const ensureWorker = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./loaders/capture-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.p, m.label);
      else if (m.type === 'error') settle('reject', new Error(m.message));
      else if (m.type === 'done') {
        const h = m.meta.height;
        settle('resolve', {
          scene: m.scene,
          meta: { ...m.meta, label, lights: null, reveal: { origin: [0, h * 0.5, 0], to: 20, hold: 1e6 } },
        });
      }
    };
    worker.onerror = (e) => settle('reject', new Error(e.message || 'The capture loader crashed.'));
    return worker;
  };
  const request = (msg, transfer) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    ensureWorker().postMessage(msg, transfer || []);
  });

  return {
    label,
    get options() { return { ...current }; },
    load(progress) {
      onProgress = progress;
      if (cached) return cached;
      progress?.(0, file ? 'Reading file' : 'Downloading');
      const base = { type: 'load', name, exposure, options: current };
      cached = file
        ? file.arrayBuffer().then((buffer) => request({ ...base, buffer }, [buffer]))
        : request({ ...base, url: new URL(url, location.href).href });
      cached.catch(() => { cached = null; this.dispose(); });
      return cached;
    },
    reframe(change) {
      current = { ...current, ...change };
      return request({ type: 'reframe', options: current });
    },
    dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}
