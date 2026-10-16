// The Stayhaus listing page: wires the splat engine into the listing's
// viewer, tour chips, Live view button and booking UI.

import { SplatViewer, captureSource } from './engine/index.js';
import { roomSource } from './room/index.js';

const $ = (id) => document.getElementById(id);
const viewerEl = $('viewer');
const touch = matchMedia('(pointer: coarse)').matches;
const params = new URLSearchParams(location.search);

let viewer, room, capture = null;

// ---------------------------------------------------------------- feedback
function showToast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function setLoader(p, text) {
  $('loader').classList.remove('is-hidden');
  $('loader-fill').style.width = `${Math.round(p * 100)}%`;
  if (text) $('loader-text').textContent = text.endsWith('…') ? text : `${text}…`;
}
const hideLoader = () => $('loader').classList.add('is-hidden');

// ---------------------------------------------------------------- tour UI
function buildStops(stops) {
  const wrap = $('stops');
  wrap.replaceChildren(...stops.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stop';
    b.role = 'tab';
    b.textContent = s.name;
    b.addEventListener('click', () => { setAutoplay(false); viewer.goTo(i); });
    return b;
  }));
}

let captionTimer = 0;
function showStop(index, stop, immediate) {
  const strip = $('stops');
  [...strip.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === index)));
  // Scroll only the chip strip (scrollIntoView would also scroll the page).
  const chip = strip.children[index];
  if (chip) strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2, behavior: immediate ? 'auto' : 'smooth' });
  const cap = $('caption');
  const fill = () => {
    $('caption-title').textContent = stop?.name || '';
    $('caption-blurb').textContent = stop?.blurb || '';
    cap.classList.remove('is-changing');
  };
  clearTimeout(captionTimer);
  if (immediate) return fill();
  cap.classList.add('is-changing');
  captionTimer = setTimeout(fill, 380);
}

function setAutoplay(on) {
  if (on) viewer.setAutoplay(true); else viewer.rig.setAutoplay(false);
  $('autoplay').setAttribute('aria-pressed', String(on));
}

// ---------------------------------------------------------------- Live view
function setLiveButton(on, label) {
  $('cam-toggle').setAttribute('aria-pressed', String(on));
  $('cam-label').textContent = label || (on ? 'Live view on' : 'Live view');
  $('recenter').hidden = !on;
}

// The tour runs on the pointer (or touch drag) by default; Live view only
// starts when the visitor asks. Phones fall back to motion if the camera
// isn't available.
async function startLiveView() {
  const btn = $('cam-toggle');
  btn.disabled = true;
  const copy = { camera: 'Opening the door…', model: 'Finding you…' };
  try {
    await viewer.input.startHead((stage) => setLiveButton(false, copy[stage]));
    setLiveButton(true);
    showToast(touch
      ? "You're in. Move your head or the phone to peek around. Your video never leaves this device."
      : "You're in. Lean to peek around the furniture, turn your head to look about. Your video never leaves this device.", 4600);
  } catch (err) {
    console.warn('Head tracking unavailable:', err);
    if (touch && await tryMotion()) { btn.disabled = false; return; }
    setLiveButton(false);
    const name = err && err.name;
    let msg;
    if (err.stage === 'model') msg = "Live view couldn't start just now, so the room follows your cursor instead.";
    else if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Live view needs your camera. Allow it from the address bar to step in; until then the room follows your cursor.';
    else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotSupportedError') msg = 'Live view needs a camera, and none was found. The room follows your cursor instead.';
    else msg = 'Your camera is busy elsewhere, so the room follows your cursor for now.';
    if (touch) msg = msg.replace('your cursor', 'your finger');
    showToast(msg, 5000);
  }
  btn.disabled = false;
}

async function tryMotion() {
  try {
    await viewer.input.startMotion();
    setLiveButton(true);
    showToast('No camera, so Live view uses motion instead: turn and tilt your phone to look around.', 4600);
    return true;
  } catch (err) {
    console.warn('Motion unavailable:', err);
    return false;
  }
}

function stopLiveView() {
  viewer.input.stop();
  setLiveButton(false);
}

// ---------------------------------------------------------------- scenes
async function show(source, opts) {
  try {
    const meta = await viewer.show(source, opts);
    hideLoader();
    return meta;
  } finally {
    updateCaptureUI();
  }
}

async function showRoom() {
  capture?.dispose();
  capture = null;
  await show(room);
  viewerEl.setAttribute('aria-label', 'Interactive 3D tour of the living room');
}

// Captures load from ?scene=<url> or by dropping a .ply/.splat on the viewer.
async function showCapture(spec) {
  const next = captureSource({ ...spec, exposure: viewer.exposure });
  try {
    const meta = await show(next);
    if (capture && capture !== next) capture.dispose();
    capture = next;
    viewerEl.setAttribute('aria-label', `Interactive 3D view of the captured scene ${next.label}`);
    showToast(`Loaded ${next.label}: ${meta.count.toLocaleString()} splats. Upside down? Use Flip.`, 4500);
    updateCaptureUI();
  } catch (err) {
    console.warn('Capture failed to load:', err);
    hideLoader();
    showToast(err.message, 6000);
    if (!viewer.meta) await showRoom();
  }
}

async function reframe(change) {
  if (!capture) return;
  setLoader(0.95, 'Re-framing');
  try {
    viewer.present(await capture.reframe(change), { reveal: false, keepStop: true });
  } catch (err) {
    showToast(err.message, 5000);
  }
  hideLoader();
  updateCaptureUI();
}

function updateCaptureUI() {
  const on = !!capture;
  $('cap-flip').hidden = $('cap-turn').hidden = $('cap-room').hidden = !on;
  $('cap-flip').setAttribute('aria-pressed', String(!!capture?.options.flip));
}

// ---------------------------------------------------------------- wiring
function wireUI() {
  $('cam-toggle').addEventListener('click', () => (viewer.input.mode === 'pointer' ? startLiveView() : stopLiveView()));
  $('recenter').addEventListener('click', () => { viewer.input.recenter(); showToast("Recentered. Wherever you are now is home base.", 2000); });
  $('prev').addEventListener('click', () => { setAutoplay(false); viewer.prev(); });
  $('next').addEventListener('click', () => { setAutoplay(false); viewer.next(); });
  $('autoplay').addEventListener('click', () => setAutoplay(!viewer.autoplay));

  const reserve = () => showToast('This is a demo listing. Nothing was booked.');
  $('reserve').addEventListener('click', () => { viewerEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); reserve(); });
  $('reserve-bar-btn').addEventListener('click', () => $('booking').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('save').addEventListener('click', (e) => {
    const b = e.currentTarget;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span').textContent = on ? 'Saved' : 'Save';
  });

  // The mobile reserve bar stays out of the way while the room or the booking
  // card itself is on screen.
  const seen = { booking: false, viewer: true };
  const watch = (el, key, threshold) => new IntersectionObserver(([e]) => {
    seen[key] = e.intersectionRatio >= threshold * 0.99;
    document.body.classList.toggle('show-reserve-bar', !seen.booking && !seen.viewer);
  }, { threshold: [0, threshold] }).observe(el);
  watch($('booking'), 'booking', 0.2);
  watch(viewerEl, 'viewer', 0.35);

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') { setAutoplay(false); viewer.next(); }
    else if (e.key === 'ArrowLeft') { setAutoplay(false); viewer.prev(); }
    else if ((e.key === 'r' || e.key === 'R') && viewer.input.mode !== 'pointer') viewer.input.recenter();
  });

  $('cap-flip').addEventListener('click', () => reframe({ flip: !capture.options.flip }));
  $('cap-turn').addEventListener('click', () => reframe({ turn: (capture.options.turn + 1) % 4 }));
  $('cap-room').addEventListener('click', () => { history.replaceState(null, '', location.pathname); showRoom(); });

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  viewerEl.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; viewerEl.classList.add('is-dropping'); });
  viewerEl.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  viewerEl.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; viewerEl.classList.remove('is-dropping'); } });
  viewerEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    viewerEl.classList.remove('is-dropping');
    const file = [...e.dataTransfer.files].find((f) => /\.(ply|splat)$/i.test(f.name)) || e.dataTransfer.files[0];
    if (file) showCapture({ file });
  });
  // A file dropped beside the viewer shouldn't navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function firstTouchHint() {
  if (!touch) return;
  try { if (localStorage.getItem('stayhaus-drag-hint')) return; localStorage.setItem('stayhaus-drag-hint', '1'); } catch {}
  setTimeout(() => showToast('Drag sideways on the room to look around.', 3600), 1200);
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (!SplatViewer.supported()) {
    $('loader-text').textContent = 'This tour needs WebGL2, which this browser does not support.';
    $('loader').querySelector('.loader__bar').hidden = true;
    return;
  }
  viewer = new SplatViewer(viewerEl, { canvas: $('splats'), quality: params.get('quality') || 'auto', exposure: 1.75 });
  room = roomSource({ quality: viewer.quality });
  viewer.addEventListener('progress', (e) => setLoader(e.detail.p, e.detail.label));
  viewer.addEventListener('scene', (e) => {
    buildStops(e.detail.meta.stops || []);
    $('splat-count').textContent = (e.detail.meta.count ?? viewer.renderer.count).toLocaleString();
  });
  viewer.addEventListener('stop', (e) => showStop(e.detail.index, e.detail.stop, !viewer.rig.flight));

  wireUI();
  setLiveButton(false);
  // No camera API (or not a secure context) and no motion sensors: touch and pointer only.
  if (!viewer.input.head.constructor.supported() && !(touch && viewer.input.motion.constructor.supported())) $('cam-toggle').hidden = true;

  const url = params.get('scene');
  if (url) await showCapture({ url, options: { flip: params.get('flip') === '1', turn: (+params.get('turn') || 0) % 4 } });
  else await showRoom();
  firstTouchHint();
}

boot();
