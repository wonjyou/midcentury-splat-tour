// Builds and light-bakes the room off the main thread.
import { buildRoom } from './scene.js';
import { serveBuilder } from '../engine/sources.js';

serveBuilder((progress, { quality }) => buildRoom(progress, { quality }));
