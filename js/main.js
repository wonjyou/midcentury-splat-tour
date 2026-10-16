// Wires the splat renderer, the procedural room and the head tracker into the
// listing page. The screen is a window: the head offset moves the eye while the
// window rectangle stays put, which gives an off-axis (asymmetric) frustum.
// Turning the head turns the camera (and the window with it).

import { LIGHTS } from './scene.js';
import { SplatRenderer } from './renderer.js';
import { HeadTracker } from './tracking.js';

const ROOM_STOPS = [
  { name: 'Living room', blurb: 'Walnut slat wall, a sunburst mirror and the long teal sofa.', pos: [0, 1.32, 3.3], target: [0, 1.0, -3.0] },
  { name: 'Desert window', blurb: 'Floor-to-ceiling glass onto the pool deck and the San Jacinto range.', pos: [1.6, 1.28, 1.7], target: [-3.2, 1.15, -1.5] },
  { name: 'Reading corner', blurb: 'A molded-plywood lounger and ottoman under the brass arc lamp.', pos: [-0.6, 1.22, 0.7], target: [2.0, 0.75, -2.3] },
  { name: 'Credenza', blurb: 'Caned walnut doors, a turntable, and an original abstract on the wall.', pos: [-0.5, 1.3, 1.6], target: [3.1, 0.75, 0.55] },
  { name: 'Sofa', blurb: 'Sink into the cushions — the sun crosses the rug by late afternoon.', pos: [0.35, 1.02, -0.3], target: [0.05, 0.85, -4.0] },
];
// The stops in use: the room's, or a loaded capture's default viewpoints.
let STOPS = ROOM_STOPS;

// How far (metres) the eye travels for a full-scale head/pointer offset.
const HEAD_RANGE = { x: 0.42, y: 0.26, z: 0.5 };
const SCREEN_DIST = 1.0;

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const canvas = $('splats');

// ---------------------------------------------------------------- camera
function poseFor(stop) {
  const d = [stop.target[0] - stop.pos[0], stop.target[1] - stop.pos[1], stop.target[2] - stop.pos[2]];
  return {
    pos: stop.pos.slice(),
    yaw: Math.atan2(-d[0], -d[2]),
    pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) * 0.6,
  };
}

function cameraMatrices(pose, head, aspect) {
  const yaw = pose.yaw + head.yaw, pitch = pose.pitch + head.pitch;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const right = [cy, 0, -sy];
  const back = [sy * cp, -sp, cy * cp];
  const up = [sp * sy, cp, sp * cy];
  const hx = head.x * HEAD_RANGE.x, hy = head.y * HEAD_RANGE.y, hz = head.z * HEAD_RANGE.z;
  const eye = [0, 1, 2].map((k) => pose.pos[k] + right[k] * hx + up[k] * hy + back[k] * hz);
  const d = (v) => v[0] * eye[0] + v[1] * eye[1] + v[2] * eye[2];
  const view = new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -d(right), -d(up), -d(back), 1,
  ]);

  // The "window" in camera space: half extents W×H at distance SCREEN_DIST.
  let W, H;
  if (aspect >= 1) { W = Math.tan((35 * Math.PI) / 180) * SCREEN_DIST; H = W / aspect; }
  else { H = Math.tan((34 * Math.PI) / 180) * SCREEN_DIST; W = H * aspect; }
  const n = 0.05, f = 80, dist = SCREEN_DIST + hz;
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
const angleLerp = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

// ---------------------------------------------------------------- state
let renderer;
let current = 0;
let pose = poseFor(STOPS[0]);
let flight = null;
let autoplay = false;
let autoTimer = 0;
const tracker = new HeadTracker(viewer);

let sorter, sortBusy = false, sortedView = null, pendingView = null;
let revealStart = 0;
// The splats fade in from `origin` out to `to` metres, then hold at `hold`.
const ROOM_REVEAL = { origin: [0, 1.1, -1.5], to: 30, hold: 31 };
let revealCfg = ROOM_REVEAL;

let roomScene = null;      // kept so "Back to the room" doesn't re-bake it
let captureWorker = null;  // holds the raw capture for flip/turn corrections
let captureOpts = { flip: false, turn: 0 };
let sceneMode = 'room';    // 'room' | 'capture'
let running = false;

function showToast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- tour stops
function buildStops() {
  const wrap = $('stops');
  wrap.replaceChildren();
  STOPS.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stop';
    b.role = 'tab';
    b.textContent = s.name;
    b.addEventListener('click', () => { setAutoplay(false); goTo(i); });
    wrap.appendChild(b);
  });
  updateStopUI(true);
}

function updateStopUI(immediate) {
  [...$('stops').children].forEach((b, i) => b.setAttribute('aria-selected', String(i === current)));
  // Scroll only the chip strip (scrollIntoView would also scroll the page).
  const strip = $('stops'), chip = strip.children[current];
  strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2, behavior: immediate ? 'auto' : 'smooth' });
  const cap = $('caption');
  const fill = () => {
    $('caption-title').textContent = STOPS[current].name;
    $('caption-blurb').textContent = STOPS[current].blurb;
    cap.classList.remove('is-changing');
  };
  if (immediate) { fill(); return; }
  cap.classList.add('is-changing');
  setTimeout(fill, 380);
}

function goTo(i) {
  i = (i + STOPS.length) % STOPS.length;
  if (i === current && !flight) return;
  current = i;
  const to = poseFor(STOPS[i]);
  const dist = Math.hypot(to.pos[0] - pose.pos[0], to.pos[2] - pose.pos[2]);
  flight = { from: { ...pose, pos: pose.pos.slice() }, to, start: performance.now(), dur: 1200 + dist * 260 };
  autoTimer = 0;
  updateStopUI(false);
}

function setAutoplay(on) {
  autoplay = on;
  autoTimer = 0;
  $('autoplay').setAttribute('aria-pressed', String(on));
}

// ---------------------------------------------------------------- tracking UI
function setCamButton(on, label) {
  const b = $('cam-toggle');
  b.setAttribute('aria-pressed', String(on));
  $('cam-label').textContent = label || (on ? 'Live view on' : 'Live view');
  $('recenter').hidden = !on;
}

// The tour runs on the pointer by default; the camera only starts when the
// visitor asks for it with the Live view button.
async function startHeadTracking() {
  $('cam-toggle').disabled = true;
  try {
    const STAGE_COPY = { 'Starting camera': 'Opening the door…', 'Loading face model': 'Finding you…' };
    await tracker.enableCamera($('video'), (stage) => setCamButton(false, STAGE_COPY[stage] || stage + '…'));
    setCamButton(true);
    showToast("You're in. Lean to peek around the furniture, turn your head to look about. Your video never leaves this device.", 4600);
  } catch (err) {
    console.warn('Head tracking unavailable:', err);
    setCamButton(false);
    const name = err && err.name;
    let msg;
    if (err.stage === 'model') msg = "Live view couldn't start just now, so the room follows your cursor instead.";
    else if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Live view needs your camera. Allow it from the address bar to step in; until then the room follows your cursor.';
    else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotSupportedError') msg = 'Live view needs a camera, and none was found. The room follows your cursor instead.';
    else msg = 'Your camera is busy elsewhere, so the room follows your cursor for now.';
    showToast(msg, 5000);
  }
  $('cam-toggle').disabled = false;
}

function stopHeadTracking() {
  tracker.disableCamera();
  setCamButton(false);
}

function wireUI() {
  $('cam-toggle').addEventListener('click', () => (tracker.mode === 'head' ? stopHeadTracking() : startHeadTracking()));
  $('recenter').addEventListener('click', () => { tracker.recenter(); showToast("Recentered. Wherever you're sitting is home base now.", 2000); });
  $('prev').addEventListener('click', () => { setAutoplay(false); goTo(current - 1); });
  $('next').addEventListener('click', () => { setAutoplay(false); goTo(current + 1); });
  $('autoplay').addEventListener('click', () => { setAutoplay(!autoplay); if (autoplay) goTo(current + 1); });
  $('reserve').addEventListener('click', () => {
    viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('This is a demo listing — nothing was booked.');
  });
  $('save').addEventListener('click', (e) => {
    const b = e.currentTarget;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span').textContent = on ? 'Saved' : 'Save';
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') { setAutoplay(false); goTo(current + 1); }
    else if (e.key === 'ArrowLeft') { setAutoplay(false); goTo(current - 1); }
    else if ((e.key === 'r' || e.key === 'R') && tracker.mode === 'head') tracker.recenter();
  });
  setCamButton(false);

  // No camera API (or not a secure context): the pointer is the only input.
  if (!HeadTracker.cameraSupported()) $('cam-toggle').hidden = true;
}

// ---------------------------------------------------------------- sort worker
function requestSort(view) {
  if (sortBusy) { pendingView = view; return; }
  sortBusy = true;
  sortedView = view;
  sorter.postMessage({ type: 'sort', view });
}

function viewMoved(a, b) {
  if (!b) return true;
  let s = 0;
  for (let i = 0; i < 16; i++) s += Math.abs(a[i] - b[i]);
  return s > 0.004;
}

// ---------------------------------------------------------------- frame loop
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
  const w = Math.round(viewer.clientWidth * dpr), h = Math.round(viewer.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  resize();

  tracker.detect(now);
  const head = tracker.update(dt, now / 1000);

  if (flight) {
    const k = Math.min(1, (now - flight.start) / flight.dur), e = ease(k);
    const { from, to } = flight;
    pose = {
      pos: [0, 1, 2].map((i) => lerp(from.pos[i], to.pos[i], e)),
      yaw: angleLerp(from.yaw, to.yaw, e),
      pitch: lerp(from.pitch, to.pitch, e),
    };
    if (k >= 1) flight = null;
  } else if (autoplay) {
    autoTimer += dt;
    if (autoTimer > 7) goTo(current + 1);
  }

  const { view, proj, eye } = cameraMatrices(pose, head, canvas.width / canvas.height);
  if (viewMoved(view, sortedView)) requestSort(view);

  const r = (now - revealStart) / 2600;
  const reveal = !revealStart ? 0 : r >= 1 ? revealCfg.hold : 1 + ease(r) * revealCfg.to;
  renderer.draw({ view, proj, eye, reveal, revealOrigin: revealCfg.origin, time: now / 1000 });
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- scenes
function setLoader(p, text) {
  $('loader').classList.remove('is-hidden');
  $('loader-fill').style.width = `${Math.round(p * 100)}%`;
  $('loader-text').textContent = text;
}

function buildScene() {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./build-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setLoader(e.data.p, `${e.data.label}…`);
      else if (e.data.type === 'done') {
        w.terminate();
        resolve(e.data.scene);
      }
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
  });
}

// Hand a scene to the renderer and a fresh depth sorter.
function useScene(scene) {
  renderer.load(scene);
  $('splat-count').textContent = scene.count.toLocaleString();
  if (sorter) sorter.terminate();
  sorter = new Worker(new URL('./sort-worker.js', import.meta.url));
  const positions = scene.positions.slice();
  sorter.postMessage({ type: 'init', positions, count: scene.count }, [positions.buffer]);
  sortBusy = false; sortedView = null; pendingView = null;
  sorter.onmessage = (e) => {
    renderer.setOrder(e.data.order);
    sortBusy = false;
    if (pendingView) { const v = pendingView; pendingView = null; requestSort(v); }
  };
  if (!running) { running = true; requestAnimationFrame(frame); }
}

function resetTour(stops) {
  STOPS = stops;
  current = 0;
  flight = null;
  setAutoplay(false);
  pose = poseFor(STOPS[0]);
  buildStops();
}

async function showRoom() {
  if (!roomScene) {
    const t0 = performance.now();
    setLoader(0, 'Placing Gaussians…');
    roomScene = await buildScene();
    console.info(`Built and lit ${roomScene.count.toLocaleString()} splats in ${Math.round(performance.now() - t0)} ms`);
  }
  sceneMode = 'room';
  if (captureWorker) { captureWorker.terminate(); captureWorker = null; }
  useScene(roomScene);
  resetTour(ROOM_STOPS);
  revealCfg = ROOM_REVEAL;
  revealStart = performance.now();
  viewer.setAttribute('aria-label', 'Interactive 3D tour of the living room');
  updateCaptureUI();
  $('loader').classList.add('is-hidden');
}

// source: { file } from drag-and-drop / the picker, or { url } from ?scene=.
function loadCapture(source, opts = { flip: false, turn: 0 }) {
  const name = source.file ? source.file.name : decodeURIComponent(source.url.split('?')[0].split('/').pop() || 'scene');
  const pretty = name.replace(/\.(ply|splat)$/i, '');
  return new Promise((resolve, reject) => {
    // The previous capture's worker stays until this one succeeds, so a bad
    // file leaves the current scene (and its flip/turn controls) working.
    const w = new Worker(new URL('./capture-worker.js', import.meta.url), { type: 'module' });
    let first = true;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') setLoader(m.p, `${m.label}…`);
      else if (m.type === 'error') {
        $('loader').classList.add('is-hidden');
        if (first) w.terminate();
        reject(new Error(m.message));
      } else if (m.type === 'done') {
        if (first) { if (captureWorker !== w) captureWorker?.terminate(); captureWorker = w; captureOpts = opts; }
        sceneMode = 'capture';
        useScene(m.scene);
        resetTour(m.meta.stops);
        const h = m.meta.height;
        // Reveal from the middle of the space; afterwards show everything, however far.
        revealCfg = { origin: [0, h * 0.5, 0], to: 20, hold: 1e6 };
        revealStart = first ? performance.now() : performance.now() - 1e5;
        viewer.setAttribute('aria-label', `Interactive 3D view of the captured scene ${pretty}`);
        updateCaptureUI();
        $('loader').classList.add('is-hidden');
        console.info(`Loaded capture "${name}": ${m.meta.count.toLocaleString()} splats, ${m.meta.metric ? 'metric' : `scaled ×${m.meta.scale.toFixed(3)}`}`);
        if (first) showToast(`Loaded ${pretty} — ${m.meta.count.toLocaleString()} splats. Upside down? Use Flip.`, 4500);
        first = false;
        resolve();
      }
    };
    w.onerror = (e) => { w.terminate(); $('loader').classList.add('is-hidden'); reject(new Error(e.message || 'The capture loader crashed.')); };
    setLoader(0, source.file ? 'Reading file…' : 'Downloading…');
    const msg = { type: 'load', name, exposure: renderer.exposure, options: opts };
    if (source.file) {
      source.file.arrayBuffer().then((buffer) => w.postMessage({ ...msg, buffer }, [buffer]), reject);
    } else {
      w.postMessage({ ...msg, url: source.url });
    }
  });
}

function reframeCapture(change) {
  if (!captureWorker || sceneMode !== 'capture') return;
  captureOpts = { ...captureOpts, ...change };
  setLoader(0.95, 'Re-framing…');
  captureWorker.postMessage({ type: 'reframe', options: captureOpts });
}

function updateCaptureUI() {
  const cap = sceneMode === 'capture';
  $('cap-flip').hidden = !cap;
  $('cap-turn').hidden = !cap;
  $('cap-room').hidden = !cap;
  $('cap-flip').setAttribute('aria-pressed', String(captureOpts.flip));
}

function tryCapture(source) {
  return loadCapture(source).catch((err) => {
    console.warn('Capture failed to load:', err);
    showToast(err.message, 6000);
    if (!roomScene && sceneMode === 'room') return showRoom();
  });
}

function wireCaptureUI() {
  // Captures load from ?scene=<url> or by dropping a file; the fix-up
  // controls below only show while one is up.
  $('cap-flip').addEventListener('click', () => reframeCapture({ flip: !captureOpts.flip }));
  $('cap-turn').addEventListener('click', () => reframeCapture({ turn: (captureOpts.turn + 1) % 4 }));
  $('cap-room').addEventListener('click', () => { history.replaceState(null, '', location.pathname); showRoom(); });

  // Drop a .ply / .splat anywhere on the viewer.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  viewer.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; viewer.classList.add('is-dropping'); });
  viewer.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  viewer.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; viewer.classList.remove('is-dropping'); } });
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    viewer.classList.remove('is-dropping');
    const file = [...e.dataTransfer.files].find((f) => /\.(ply|splat)$/i.test(f.name)) || e.dataTransfer.files[0];
    if (!file) return;
    tryCapture({ file });
  });
  // A file dropped beside the viewer shouldn't navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- boot
async function boot() {
  buildStops();
  wireUI();
  wireCaptureUI();
  try {
    renderer = new SplatRenderer(canvas);
  } catch (err) {
    console.error(err);
    $('loader-text').textContent = 'This tour needs WebGL2, which this browser does not support.';
    $('loader').querySelector('.loader__bar').hidden = true;
    return;
  }
  renderer.setLights(LIGHTS);
  renderer.exposure = 1.75;
  updateCaptureUI();

  // ?scene=<url of a .ply or .splat> loads a real capture instead of the room.
  const params = new URLSearchParams(location.search);
  const url = params.get('scene');
  if (url) {
    const opts = { flip: params.get('flip') === '1', turn: (+params.get('turn') || 0) % 4 };
    await loadCapture({ url: new URL(url, location.href).href }, opts).catch((err) => {
      console.warn('Capture failed to load:', err);
      showToast(err.message, 6000);
      return showRoom();
    });
  } else {
    await showRoom();
  }
}

boot();
