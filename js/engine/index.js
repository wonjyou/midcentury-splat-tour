// Gaussian splat "window" viewer.
//
//   import { SplatViewer, workerSource, captureSource } from './engine/index.js';
//   const viewer = new SplatViewer(document.querySelector('#stage'));
//   await viewer.show(captureSource({ url: 'room.ply' }));
//   viewer.input.startHead();          // opt-in webcam head tracking
//
// See README.md for the scene contract and the input sources.

export { SplatViewer, detectQuality } from './viewer.js';
export { workerSource, captureSource, serveBuilder } from './sources.js';
export { SplatRenderer } from './renderer.js';
export { DepthSorter } from './sorter.js';
export { CameraRig, windowCamera, lookAtPose, DEFAULT_WINDOW } from './camera.js';
export { InputController } from './input/controller.js';
export { PointerInput } from './input/pointer.js';
export { HeadInput } from './input/head.js';
export { MotionInput } from './input/motion.js';
export { OneEuro } from './input/filters.js';
export { ENCODE, MAT, MATERIALS, encodeRadiance, packNormal, packExtra } from './format.js';
