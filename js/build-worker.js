// Builds and light-bakes the room off the main thread.
import { buildRoom } from './scene.js';

const scene = buildRoom((p, label) => self.postMessage({ type: 'progress', p, label }));
self.postMessage({ type: 'done', scene }, [
  scene.positions.buffer, scene.covariances.buffer, scene.colors.buffer, scene.normals.buffer, scene.extra.buffer,
]);
