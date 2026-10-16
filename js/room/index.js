// The furnished 1958 living room as a scene source for the engine.

import { workerSource } from '../engine/sources.js';
import { LIGHTS } from './scene.js';

export const ROOM_STOPS = [
  { name: 'Living room', blurb: 'Walnut slat wall, a sunburst mirror and the long teal sofa.', pos: [0, 1.32, 3.3], target: [0, 1.0, -3.0] },
  { name: 'Desert window', blurb: 'Floor-to-ceiling glass onto the pool deck and the San Jacinto range.', pos: [1.6, 1.28, 1.7], target: [-3.2, 1.15, -1.5] },
  { name: 'Reading corner', blurb: 'A molded-plywood lounger and ottoman under the brass arc lamp.', pos: [-0.6, 1.22, 0.7], target: [2.0, 0.75, -2.3] },
  { name: 'Credenza', blurb: 'Caned walnut doors, a turntable, and an original abstract on the wall.', pos: [-0.5, 1.3, 1.6], target: [3.1, 0.75, 0.55] },
  { name: 'Sofa', blurb: 'Sink into the cushions; the sun crosses the rug by late afternoon.', pos: [0.35, 1.02, -0.3], target: [0.05, 0.85, -4.0] },
];

// quality: 'high' (about 566k splats) or 'low' (about 340k, fewer bounce rays).
export function roomSource({ quality = 'high' } = {}) {
  return workerSource(new URL('./build-worker.js', import.meta.url), {
    message: { quality },
    meta: {
      label: 'Living room',
      stops: ROOM_STOPS,
      lights: LIGHTS,
      reveal: { origin: [0, 1.1, -1.5], to: 30, hold: 31 },
    },
  });
}
