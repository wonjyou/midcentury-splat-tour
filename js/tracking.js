// Where is the viewer's head? Webcam face tracking (MediaPipe Face Landmarker)
// when a camera is available, otherwise the pointer stands in for the head.
// Output: a normalised position offset (x/y in about [-1, 1], z < 0 when leaning
// in) plus head rotation (yaw/pitch, radians, already amplified) that turns the camera.

const MP_VERSION = '0.10.14';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Face mesh indices. Each feature is averaged over several stable points,
// which cuts per-landmark noise a lot: corners of each eye, and the nose ridge.
const EYE_R = [33, 133, 159, 145], EYE_L = [263, 362, 386, 374], NOSE = [1, 4, 5, 195];
// A small real head turn should reveal a lot of room, so rotation is amplified.
const YAW_GAIN = 2.6, PITCH_GAIN = 1.6;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const AXES = ['x', 'y', 'z', 'yaw', 'pitch'];

function centroid(lm, ids) {
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// One Euro filter (Casiez et al. 2012): an adaptive low-pass that smooths hard
// when the signal is steady and opens up when it moves fast, so holding still
// is calm but quick head moves don't lag.
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

export class HeadTracker {
  constructor(surface) {
    this.surface = surface;
    this.mode = 'pointer';           // 'pointer' | 'head'
    this.target = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    this.value = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    this.face = null;                 // last face position in the video, for the preview dot
    this.lastPointer = -Infinity;
    this.lastFace = -Infinity;
    this.centre = null;
    this.calib = [];
    this.lastVideoTime = -1;
    this.stream = null;
    // Rotation is amplified, so it gets a lower resting cutoff than position.
    this.filters = {
      x: new OneEuro(0.9, 0.35), y: new OneEuro(0.9, 0.35), z: new OneEuro(0.6, 0.25),
      yaw: new OneEuro(0.55, 0.3), pitch: new OneEuro(0.55, 0.3),
    };

    const onMove = (x, y) => {
      if (this.mode !== 'pointer') return;
      const r = surface.getBoundingClientRect();
      // The pointer stands in for where you look: it turns the view, with a
      // little sideways parallax to keep the depth readable.
      const nx = clamp(((x - r.left) / r.width) * 2 - 1, -1.2, 1.2);
      const ny = clamp(-(((y - r.top) / r.height) * 2 - 1), -1.2, 1.2);
      this.target.yaw = -nx * 0.62;
      this.target.pitch = ny * 0.22;
      this.target.x = -nx * 0.35;
      this.target.y = -ny * 0.25;
      this.target.z = 0;
      this.lastPointer = performance.now();
    };
    window.addEventListener('pointermove', (e) => onMove(e.clientX, e.clientY), { passive: true });
    surface.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY); }, { passive: true });
  }

  static cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  // Resolves once tracking is live; throws with err.stage = 'camera' | 'model'.
  async enableCamera(video, onStage) {
    let stage = 'camera';
    try {
      if (!HeadTracker.cameraSupported()) throw Object.assign(new Error('No camera API'), { name: 'NotSupportedError' });
      onStage?.('Starting camera');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
      video.srcObject = this.stream;
      await video.play();
      this.video = video;
      if (!this.landmarker) {
        stage = 'model';
        onStage?.('Loading face model');
        const { FaceLandmarker, FilesetResolver } = await import(MP_BUNDLE);
        const files = await FilesetResolver.forVisionTasks(MP_WASM);
        const make = (delegate) => FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
      }
      this.recenter();
      this.mode = 'head';
      this.lastFace = performance.now();
    } catch (err) {
      this.disableCamera();
      err.stage = stage;
      throw err;
    }
  }

  disableCamera() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.mode = 'pointer';
    this.face = null;
    this.target = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  }

  // The next ~half second of frames becomes the new "neutral" head position.
  recenter() {
    this.centre = null;
    this.calib = [];
    for (const f of Object.values(this.filters)) f.reset();
  }

  get faceVisible() {
    return this.mode === 'head' && performance.now() - this.lastFace < 600;
  }

  get pointerIdle() {
    return performance.now() - this.lastPointer > 3500;
  }

  detect(now) {
    const v = this.video;
    if (this.mode !== 'head' || !this.landmarker || !v || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const res = this.landmarker.detectForVideo(v, now);
    const lm = res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) return;
    const r = centroid(lm, EYE_R), l = centroid(lm, EYE_L), nose = centroid(lm, NOSE);
    const mx = (r.x + l.x) / 2, my = (r.y + l.y) / 2;
    const eye = Math.hypot(r.x - l.x, r.y - l.y);
    // Where the nose sits relative to the eyes gives head yaw and pitch.
    const yaw = (nose.x - mx) / eye, pitch = (nose.y - my) / eye;
    this.face = { x: mx, y: my };
    this.lastFace = performance.now();

    if (!this.centre) {
      this.calib.push([mx, my, eye, yaw, pitch]);
      if (this.calib.length >= 12) {
        const avg = [0, 0, 0, 0, 0];
        for (const c of this.calib) for (let k = 0; k < 5; k++) avg[k] += c[k] / this.calib.length;
        // Keep horizontal neutral near the frame centre so sitting off to one side still reads as "off to one side".
        this.centre = { x: 0.5 + (avg[0] - 0.5) * 0.5, y: avg[1], eye: avg[2], yaw: avg[3], pitch: avg[4] };
      }
      return;
    }
    // The camera image is unmirrored: moving to your right moves you left in the frame.
    // Turning your head to the left moves the nose toward the image's right edge,
    // which turns the camera left (positive yaw). Looking up raises the nose.
    // A soft dead zone keeps the view still when you're only holding still.
    const soft = (v, w) => Math.sign(v) * Math.max(0, Math.abs(v) - w * Math.exp(-Math.abs(v) / w));
    const t = now / 1000, f = this.filters;
    this.target.x = clamp(f.x.filter((this.centre.x - mx) * 3.4, t), -1.3, 1.3);
    this.target.y = clamp(f.y.filter((this.centre.y - my) * 3.4, t), -1.3, 1.3);
    this.target.z = clamp(f.z.filter((this.centre.eye / eye - 1) * 2.2, t), -1, 1);
    this.target.yaw = clamp(soft(f.yaw.filter(yaw - this.centre.yaw, t), 0.035) * YAW_GAIN, -1.25, 1.25);
    this.target.pitch = clamp(-soft(f.pitch.filter(pitch - this.centre.pitch, t), 0.035) * PITCH_GAIN, -0.45, 0.45);
  }

  update(dt, t) {
    if (this.mode === 'head') {
      if (!this.faceVisible) for (const a of AXES) this.target[a] *= 0.97;
    } else if (this.pointerIdle) {
      // Nobody is steering: drift slowly so the parallax still shows.
      this.target.yaw = 0.32 * Math.sin(t * 0.21);
      this.target.pitch = 0.06 * Math.sin(t * 0.17 + 1.2);
      this.target.x = 0.4 * Math.sin(t * 0.33);
      this.target.y = 0.15 * Math.sin(t * 0.27 + 0.5);
      this.target.z = 0;
    }
    // Detection runs at camera rate (~30 fps); this follow fills in the frames
    // between detections so the view glides instead of stepping.
    const k = 1 - Math.exp(-dt * (this.mode === 'head' ? 9 : 6));
    for (const a of AXES) this.value[a] += (this.target[a] - this.value[a]) * k;
    return this.value;
  }
}
