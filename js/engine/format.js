// The splat data contract shared by every scene source and the renderer.
//
// A scene is a set of typed arrays, one entry per splat:
//   count        number of splats
//   positions    Float32Array(count * 3)   world-space centre, metres, y up
//   covariances  Float32Array(count * 6)   3D covariance: xx xy xz yy yz zz
//   colors       Uint8Array(count * 4)     radiance encoded with ENCODE, plus alpha
//   normals      Uint32Array(count)        unit normal packed 10:10:10 (packNormal)
//   extra        Uint32Array(count)        material id | sun visibility | sky visibility (packExtra)
//
// Sources (procedural builders, capture loaders) produce this; the renderer and
// depth sorter consume it and never need to know where the splats came from.

// Colour encoding: linear HDR radiance in [0, RANGE], stored with a 1/GAMMA curve.
export const ENCODE = { RANGE: 6, GAMMA: 2.4 };

// Material ids, indexes into MATERIALS.
export const MAT = { matte: 0, satin: 1, polished: 2, leather: 3, brass: 4, alu: 5, glaze: 6, fabric: 7, vinyl: 8, mirror: 9, paint: 10 };

// Per-material view-dependent specular: [strength, shininess, metallic].
export const MATERIALS = [
  [0, 1, 0],        // matte
  [0.5, 50, 0],     // satin (oak floor, frames)
  [0.75, 110, 0],   // polished walnut
  [0.45, 26, 0],    // leather
  [1.0, 70, 1],     // brass
  [1.0, 140, 1],    // aluminium
  [0.8, 220, 0],    // ceramic glaze
  [0, 1, 0],        // fabric
  [0.6, 120, 0],    // vinyl
  [1.0, 900, 1],    // mirror
  [0.12, 10, 0],    // eggshell paint
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// Linear radiance → one 8-bit channel.
export function encodeRadiance(x) {
  return clamp(Math.round(Math.pow(clamp(x / ENCODE.RANGE, 0, 1), 1 / ENCODE.GAMMA) * 255), 0, 255);
}

export function packNormal(x, y, z) {
  const q = (v) => clamp(Math.round((v * 0.5 + 0.5) * 1023), 0, 1023);
  return (q(x) | (q(y) << 10) | (q(z) << 20)) >>> 0;
}

// sunVis / skyVis in [0, 1] tell the renderer how much of the sun and the sky
// a splat sees, so specular highlights respect baked shadows.
export function packExtra(material, sunVis = 0, skyVis = 0) {
  return (material | (Math.round(clamp(sunVis, 0, 1) * 255) << 8) | (Math.round(clamp(skyVis, 0, 1) * 255) << 16)) >>> 0;
}

// The buffers of a scene, for transferring it between threads.
export function sceneTransferables(scene) {
  return [scene.positions.buffer, scene.covariances.buffer, scene.colors.buffer, scene.normals.buffer, scene.extra.buffer];
}
