// Head pose from the webcam with MediaPipe Face Landmarker.
//
// target.x/y: where the head is relative to its calibrated neutral, about
// [-1, 1]; z < 0 when leaning in. target.yaw/pitch: head rotation in radians,
// amplified so a small real turn reveals a lot of the scene.

import { AXES, OneEuro, clamp, zeroPose } from './filters.js';

const MP_VERSION = '0.10.14';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Face mesh indices. Each feature is averaged over several stable points,
// which cuts per-landmark noise a lot: corners of each eye, and the nose ridge.
const EYE_R = [33, 133, 159, 145], EYE_L = [263, 362, 386, 374], NOSE = [1, 4, 5, 195];

function centroid(lm, ids) {
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// A hidden <video> for the face model. It stays rendered (not display:none)
// so every browser keeps decoding frames; it is never visible.
function hiddenVideo() {
  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = true;
  v.setAttribute('aria-hidden', 'true');
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(v);
  return v;
}

export class HeadInput {
  constructor({ yawGain = 2.6, pitchGain = 1.6, positionGain = 3.4 } = {}) {
    this.gain = { yaw: yawGain, pitch: pitchGain, pos: positionGain };
    this.active = false;
    this.target = zeroPose();
    this.face = null;
    this.lastFace = -Infinity;
    this.centre = null;
    this.calib = [];
    this.lastVideoTime = -1;
    // Rotation is amplified, so it gets a lower resting cutoff than position.
    this.filters = {
      x: new OneEuro(0.9, 0.35), y: new OneEuro(0.9, 0.35), z: new OneEuro(0.6, 0.25),
      yaw: new OneEuro(0.55, 0.3), pitch: new OneEuro(0.55, 0.3),
    };
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  // Resolves once tracking is live; throws with err.stage = 'camera' | 'model'.
  // onStage('camera' | 'model') reports progress.
  async start(onStage) {
    let stage = 'camera';
    try {
      if (!HeadInput.supported()) throw Object.assign(new Error('No camera API'), { name: 'NotSupportedError' });
      onStage?.('camera');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
      this.video ??= hiddenVideo();
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.landmarker) {
        stage = 'model';
        onStage?.('model');
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
      this.active = true;
      this.lastFace = performance.now();
    } catch (err) {
      this.stop();
      err.stage = stage;
      throw err;
    }
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.active = false;
    this.face = null;
    this.target = zeroPose();
  }

  dispose() {
    this.stop();
    this.video?.remove();
    this.video = null;
    this.landmarker?.close?.();
    this.landmarker = null;
  }

  // The next ~half second of frames becomes the new neutral head pose.
  recenter() {
    this.centre = null;
    this.calib = [];
    for (const f of Object.values(this.filters)) f.reset();
  }

  get visible() {
    return this.active && performance.now() - this.lastFace < 600;
  }

  // Call once per animation frame; does work only when the camera has a new frame.
  update(now) {
    const v = this.video;
    if (!this.active || !this.landmarker || !v || v.readyState < 2 || v.currentTime === this.lastVideoTime) {
      if (this.active && !this.visible) for (const a of AXES) this.target[a] *= 0.97;
      return;
    }
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
    const t = now / 1000, f = this.filters, g = this.gain;
    this.target.x = clamp(f.x.filter((this.centre.x - mx) * g.pos, t), -1.3, 1.3);
    this.target.y = clamp(f.y.filter((this.centre.y - my) * g.pos, t), -1.3, 1.3);
    this.target.z = clamp(f.z.filter((this.centre.eye / eye - 1) * 2.2, t), -1, 1);
    this.target.yaw = clamp(soft(f.yaw.filter(yaw - this.centre.yaw, t), 0.035) * g.yaw, -1.25, 1.25);
    this.target.pitch = clamp(-soft(f.pitch.filter(pitch - this.centre.pitch, t), 0.035) * g.pitch, -0.45, 0.45);
  }
}
