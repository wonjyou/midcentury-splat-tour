// Loads real, captured 3D Gaussian Splatting scenes (Polycam, Luma, Scaniverse,
// a standard 3DGS training run…) and turns them into the same per-splat arrays
// the procedural room produces, so the renderer, sorter and camera don't care
// where the splats came from.
//
// Supported: standard 3DGS .ply (binary little-endian; x y z, f_dc_0..2,
// opacity, scale_0..2, rot_0..3; plain coloured point clouds also work) and
// the antimatter15 .splat format (32 bytes per splat).
//
// Captures come in arbitrary frames and units (COLMAP is usually y-down), so
// they are levelled with a PCA of the splat cloud, the floor is put at y = 0,
// and non-metric captures are scaled to room size. Two default viewpoints are
// picked in free space at eye height.

import { ENCODE } from '../format.js';

const SH_C0 = 0.28209479177387814;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ---------------------------------------------------------------- parsing
// Raw capture: positions (xyz), scales (linear), rotations (unit quaternion
// w x y z), colors (display sRGB, 0..1) and alpha (0..1).

export function parseCapture(buffer, name = '') {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isPly = head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79; // "ply"
  if (isPly) return parsePly(buffer);
  if (/\.splat$/i.test(name) || buffer.byteLength % 32 === 0) return parseSplat(buffer);
  throw new Error("That file isn't a Gaussian splat .ply or .splat.");
}

const PLY_TYPES = {
  char: ['Int8', 1], int8: ['Int8', 1], uchar: ['Uint8', 1], uint8: ['Uint8', 1],
  short: ['Int16', 2], int16: ['Int16', 2], ushort: ['Uint16', 2], uint16: ['Uint16', 2],
  int: ['Int32', 4], int32: ['Int32', 4], uint: ['Uint32', 4], uint32: ['Uint32', 4],
  float: ['Float32', 4], float32: ['Float32', 4], double: ['Float64', 8], float64: ['Float64', 8],
};

function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const marker = 'end_header\n';
  let end = -1;
  const limit = Math.min(bytes.length, 64 * 1024);
  outer: for (let i = 0; i < limit; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker.charCodeAt(j)) continue outer;
    end = i + marker.length;
    break;
  }
  if (end < 0) throw new Error('This .ply has no readable header.');
  const header = new TextDecoder().decode(bytes.subarray(0, end));
  if (!/format binary_little_endian/.test(header)) throw new Error('Only binary little-endian .ply files are supported (ASCII and big-endian are not).');

  // Elements in order, each with its property layout.
  const elements = [];
  for (const line of header.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'element') elements.push({ name: t[1], count: +t[2], props: [], stride: 0 });
    else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') throw new Error('This .ply stores faces or lists, not Gaussian splats.');
      const type = PLY_TYPES[t[1]];
      if (!el || !type) throw new Error(`Unsupported .ply property type "${t[1]}".`);
      el.props.push({ name: t[2], get: type[0], offset: el.stride });
      el.stride += type[1];
    }
  }
  let offset = end;
  let vertex = null;
  for (const el of elements) {
    if (el.name === 'vertex') { vertex = el; break; }
    offset += el.count * el.stride;
  }
  if (!vertex) throw new Error('This .ply has no vertex element.');
  const P = Object.fromEntries(vertex.props.map((p) => [p.name, p]));
  if (P.packed_position) throw new Error('Compressed .ply (SuperSplat/PlayCanvas) isn’t supported yet — export an uncompressed .ply or .splat.');
  if (!P.x || !P.y || !P.z) throw new Error('This .ply has no x/y/z positions.');

  const n = vertex.count, stride = vertex.stride;
  if (offset + n * stride > buffer.byteLength) throw new Error('This .ply is truncated.');
  const dv = new DataView(buffer, offset, n * stride);
  const reader = (p) => {
    if (!p) return null;
    const fn = dv['get' + p.get].bind(dv), o = p.offset;
    return (i) => fn(i * stride + o, true);
  };
  const rx = reader(P.x), ry = reader(P.y), rz = reader(P.z);
  const dc = [reader(P.f_dc_0), reader(P.f_dc_1), reader(P.f_dc_2)];
  const rgb = [reader(P.red), reader(P.green), reader(P.blue)];
  const rgbScale = P.red && /Float/.test(P.red.get) ? 1 : 1 / 255;
  const rop = reader(P.opacity);
  const rs = [reader(P.scale_0), reader(P.scale_1), reader(P.scale_2)];
  const rr = [reader(P.rot_0), reader(P.rot_1), reader(P.rot_2), reader(P.rot_3)];
  const hasDc = dc.every(Boolean), hasRgb = rgb.every(Boolean);
  const hasScale = rs.every(Boolean), hasRot = rr.every(Boolean);

  const out = allocRaw(n);
  for (let i = 0; i < n; i++) {
    out.positions[i * 3] = rx(i);
    out.positions[i * 3 + 1] = ry(i);
    out.positions[i * 3 + 2] = rz(i);
    for (let k = 0; k < 3; k++) {
      out.colors[i * 3 + k] = hasDc ? clamp(0.5 + SH_C0 * dc[k](i), 0, 1) : hasRgb ? clamp(rgb[k](i) * rgbScale, 0, 1) : 0.7;
      out.scales[i * 3 + k] = hasScale ? Math.exp(rs[k](i)) : NaN;
    }
    out.alpha[i] = rop ? sigmoid(rop(i)) : 1;
    if (hasRot) setQuat(out.rotations, i, rr[0](i), rr[1](i), rr[2](i), rr[3](i));
    else setQuat(out.rotations, i, 1, 0, 0, 0);
  }
  if (!hasScale) fillPointScales(out);
  return out;
}

function parseSplat(buffer) {
  const n = Math.floor(buffer.byteLength / 32);
  if (!n) throw new Error('This .splat file is empty.');
  const f = new Float32Array(buffer, 0, n * 8);
  const u = new Uint8Array(buffer, 0, n * 32);
  const out = allocRaw(n);
  for (let i = 0; i < n; i++) {
    const fo = i * 8, bo = i * 32;
    out.positions[i * 3] = f[fo];
    out.positions[i * 3 + 1] = f[fo + 1];
    out.positions[i * 3 + 2] = f[fo + 2];
    out.scales[i * 3] = f[fo + 3];
    out.scales[i * 3 + 1] = f[fo + 4];
    out.scales[i * 3 + 2] = f[fo + 5];
    out.colors[i * 3] = u[bo + 24] / 255;
    out.colors[i * 3 + 1] = u[bo + 25] / 255;
    out.colors[i * 3 + 2] = u[bo + 26] / 255;
    out.alpha[i] = u[bo + 27] / 255;
    setQuat(out.rotations, i, (u[bo + 28] - 128) / 128, (u[bo + 29] - 128) / 128, (u[bo + 30] - 128) / 128, (u[bo + 31] - 128) / 128);
  }
  return out;
}

function allocRaw(n) {
  return {
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    colors: new Float32Array(n * 3),
    alpha: new Float32Array(n),
  };
}

function setQuat(q, i, w, x, y, z) {
  const l = Math.hypot(w, x, y, z) || 1;
  q[i * 4] = w / l; q[i * 4 + 1] = x / l; q[i * 4 + 2] = y / l; q[i * 4 + 3] = z / l;
}

// A plain point cloud has no splat sizes: give each point a round splat about
// the size of the typical spacing between points.
function fillPointScales(raw) {
  const n = raw.count, p = raw.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = p[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  const area = (hi[0] - lo[0]) * (hi[1] - lo[1]) + (hi[1] - lo[1]) * (hi[2] - lo[2]) + (hi[0] - lo[0]) * (hi[2] - lo[2]);
  const s = Math.sqrt(Math.max(area, 1e-6) / n) * 0.7;
  raw.scales.fill(s);
}

// ---------------------------------------------------------------- framing
// A frame maps capture space to tour space: tour = k * R * (p - origin).

function percentile(sorted, q) {
  return sorted[clamp(Math.round(q * (sorted.length - 1)), 0, sorted.length - 1)];
}

function sample(raw, max = 200000) {
  const step = Math.max(1, Math.floor(raw.count / max));
  const idx = [];
  for (let i = 0; i < raw.count; i += step) if (raw.alpha[i] > 0.2) idx.push(i);
  return { idx, step };
}

// Eigen-decomposition of a symmetric 3x3 (Jacobi). Returns eigenvectors as
// columns sorted by descending eigenvalue.
function eigenSym3(A) {
  const a = [A[0].slice(), A[1].slice(), A[2].slice()];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return order.map((i) => ({ value: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] }));
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Level the capture: the thinnest principal axis of the (trimmed) cloud is
// vertical — rooms are wider than they are tall, outdoor captures are mostly
// ground. Its sign comes from where the mass sits (furniture and ground
// cluster low, ceilings and sky are sparse), falling back to COLMAP's y-down.
export function autoBasis(raw) {
  const { idx } = sample(raw);
  const p = raw.positions;
  const lo = [], hi = [];
  for (let k = 0; k < 3; k++) {
    const vals = Float32Array.from(idx, (i) => p[i * 3 + k]).sort();
    lo.push(percentile(vals, 0.1)); hi.push(percentile(vals, 0.9));
  }
  const inner = idx.filter((i) => [0, 1, 2].every((k) => p[i * 3 + k] >= lo[k] && p[i * 3 + k] <= hi[k]));
  const use = inner.length > 100 ? inner : idx;
  const mean = [0, 0, 0];
  for (const i of use) for (let k = 0; k < 3; k++) mean[k] += p[i * 3 + k] / use.length;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of use) {
    const d = [p[i * 3] - mean[0], p[i * 3 + 1] - mean[1], p[i * 3 + 2] - mean[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += (d[r] * d[c]) / use.length;
  }
  const [major, mid, minor] = eigenSym3(C);
  let up = minor.vec;

  // Skew of the full (untrimmed) cloud along a candidate up axis.
  const skewAlong = (u) => {
    let m2 = 0, m3 = 0, mu = 0;
    for (const i of idx) mu += dot(u, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]) / idx.length;
    for (const i of idx) {
      const d = dot(u, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]) - mu;
      m2 += d * d; m3 += d * d * d;
    }
    return m3 / idx.length / Math.pow(m2 / idx.length || 1, 1.5);
  };
  const orient = (u) => {
    const skew = skewAlong(u);
    if (Math.abs(skew) > 0.15) return skew < 0 ? u.map((x) => -x) : u;
    return u[1] > 0 ? u.map((x) => -x) : u; // COLMAP convention: y points down
  };
  up = orient(up);
  const x = mid.vec;
  // Rows of R are the tour axes expressed in capture space.
  const R = [x, up, cross(x, up)];

  // An object can be tall and thin, so PCA says nothing about its up; trust
  // the file's own y axis instead.
  const objUp = orient([0, 1, 0]);
  const objectR = [[1, 0, 0], objUp, cross([1, 0, 0], objUp)];
  return { R, objectR, origin: mean };
}

const matMul = (A, B) => A.map((row) => [0, 1, 2].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));

// User corrections on top of the automatic levelling: flip upside down
// (180° about x) and quarter turns about the vertical.
export function frameFor(raw, basis, { flip = false, turn = 0, object = false } = {}) {
  const F = flip ? [[1, 0, 0], [0, -1, 0], [0, 0, -1]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a = (turn % 4) * (Math.PI / 2), c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const T = [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  const R = matMul(T, matMul(F, object ? basis.objectR : basis.R));

  // Robust bounds in the levelled frame decide scale and floor height.
  const { idx } = sample(raw);
  const p = raw.positions, o = basis.origin;
  const axes = [[], [], []];
  for (const i of idx) {
    const d = [p[i * 3] - o[0], p[i * 3 + 1] - o[1], p[i * 3 + 2] - o[2]];
    for (let k = 0; k < 3; k++) axes[k].push(dot(R[k], d));
  }
  const sorted = axes.map((v) => Float32Array.from(v).sort());
  const q = (k, t) => percentile(sorted[k], t);
  const dx = q(0, 0.95) - q(0, 0.05), dz = q(2, 0.95) - q(2, 0.05), dy = q(1, 0.97) - q(1, 0.02);
  // Phone captures (Polycam, Scaniverse, Luma with ARKit) are already in metres;
  // COLMAP runs are not, so those get scaled to a room-sized span.
  // Object captures are shown about 1.4 m across, close enough for parallax to read.
  const metric = !object && dy > 1.6 && dy < 6 && Math.max(dx, dz) > 1.5 && Math.max(dx, dz) < 40;
  // Room-sized span, but no taller than a room (captures often take in the
  // view outside, which would otherwise make the room itself tiny or huge).
  const k = object ? 1.4 / Math.max(dx, dz, dy, 1e-6) : metric ? 1 : Math.min(6.5 / Math.max(dx, dz, 1e-6), 3.2 / Math.max(dy, 1e-6));
  const shift = [-(q(0, 0.5)) * k, -q(1, 0.02) * k, -(q(2, 0.5)) * k];
  return {
    R, k, origin: o, shift, metric,
    bounds: {
      x0: (q(0, 0.05) - q(0, 0.5)) * k, x1: (q(0, 0.95) - q(0, 0.5)) * k,
      z0: (q(2, 0.05) - q(2, 0.5)) * k, z1: (q(2, 0.95) - q(2, 0.5)) * k,
      h: dy * k,
    },
  };
}

// ---------------------------------------------------------------- output
const acesInv = (y) => {
  // Inverse of the renderer's ACES fit: (2.51 - 2.43y)x² + (0.03 - 0.59y)x - 0.14y = 0.
  const A = 2.51 - 2.43 * y, B = 0.03 - 0.59 * y, C = -0.14 * y;
  return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
};

// Captured colours are what the camera saw on screen (display sRGB), so they
// are turned back into the linear radiance that, after the renderer's own
// exposure, warm grade, ACES and 2.2 gamma, displays as the captured colour.
// That keeps a capture as bright as it was shot, next to the baked room.
export function encodeColors(raw, exposure) {
  const n = raw.count, out = new Uint8Array(n * 4);
  const { RANGE, GAMMA } = ENCODE;
  const grade = [1.03, 1.0, 0.96];
  const lut = new Uint8Array(3 * 1024);
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < 1024; i++) {
    const target = Math.min(Math.pow(i / 1023, 2.2), 0.985);
    const L = acesInv(target) / exposure / grade[ch];
    lut[ch * 1024 + i] = clamp(Math.round(Math.pow(clamp(L / RANGE, 0, 1), 1 / GAMMA) * 255), 0, 255);
  }
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = lut[ch * 1024 + Math.round(raw.colors[i * 3 + ch] * 1023)];
    out[i * 4 + 3] = Math.round(clamp(raw.alpha[i], 0, 1) * 255);
  }
  return out;
}

// Positions, covariances and normals in tour space. Material 0 (matte) and no
// sun/sky visibility: a capture already has its lighting baked into colour.
export function transformCapture(raw, frame) {
  const n = raw.count;
  const { R, k, origin: o, shift } = frame;
  const positions = new Float32Array(n * 3);
  const covariances = new Float32Array(n * 6);
  const normals = new Uint32Array(n);
  const extra = new Uint32Array(n);
  const P = raw.positions, S = raw.scales, Q = raw.rotations;
  const q10 = (v) => clamp(Math.round((v * 0.5 + 0.5) * 1023), 0, 1023);
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - o[0], dy = P[i * 3 + 1] - o[1], dz = P[i * 3 + 2] - o[2];
    for (let r = 0; r < 3; r++) positions[i * 3 + r] = k * (R[r][0] * dx + R[r][1] * dy + R[r][2] * dz) + shift[r];

    const w = Q[i * 4], x = Q[i * 4 + 1], y = Q[i * 4 + 2], z = Q[i * 4 + 3];
    // Columns of the splat's rotation (its local axes), in capture space.
    const ax = [
      [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
      [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
      [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
    ];
    const s = [S[i * 3], S[i * 3 + 1], S[i * 3 + 2]];
    // M = k R Rq diag(s); covariance = M Mᵀ.
    for (let c = 0; c < 3; c++) {
      const a = ax[c];
      for (let r = 0; r < 3; r++) M[r * 3 + c] = k * s[c] * (R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2]);
    }
    const cv = i * 6;
    covariances[cv] = M[0] * M[0] + M[1] * M[1] + M[2] * M[2];
    covariances[cv + 1] = M[0] * M[3] + M[1] * M[4] + M[2] * M[5];
    covariances[cv + 2] = M[0] * M[6] + M[1] * M[7] + M[2] * M[8];
    covariances[cv + 3] = M[3] * M[3] + M[4] * M[4] + M[5] * M[5];
    covariances[cv + 4] = M[3] * M[6] + M[4] * M[7] + M[5] * M[8];
    covariances[cv + 5] = M[6] * M[6] + M[7] * M[7] + M[8] * M[8];

    // Normal: the splat's thinnest axis.
    const m = s[0] <= s[1] && s[0] <= s[2] ? 0 : s[1] <= s[2] ? 1 : 2;
    const a = ax[m];
    const nx = dot(R[0], a), ny = dot(R[1], a), nz = dot(R[2], a);
    normals[i] = (q10(nx) | (q10(ny) << 10) | (q10(nz) << 20)) >>> 0;
  }
  return { count: n, positions, covariances, normals, extra };
}

// ---------------------------------------------------------------- viewpoints
// A capture only looks right from near where it was shot, and captures are
// shot from the open space in the middle of a room (or around an object). So:
// map what's at eye height, stand where there's the most clearance, and look
// back towards the middle of the capture. Without such a spot (an object
// capture), stand back from it instead.
export function defaultStops(positions, alpha, frame, label) {
  const count = alpha.length;
  const { x0, x1, z0, z1, h } = frame.bounds;
  const eyeH = clamp(h * 0.5, 0.4, 1.5);
  const span = Math.max(x1 - x0, z1 - z0);
  const cell = Math.max(0.1, span / 56);
  const pad = 0.15 * span;
  const gx0 = x0 - pad, gz0 = z0 - pad;
  const W = Math.ceil((x1 - x0 + 2 * pad) / cell), D = Math.ceil((z1 - z0 + 2 * pad) / cell);
  const grid = new Float32Array(W * D);
  const step = Math.max(1, Math.floor(count / 400000));
  for (let i = 0; i < count; i += step) {
    if (alpha[i] < 0.3) continue;
    const y = positions[i * 3 + 1];
    if (y < eyeH - 0.6 || y > eyeH + 0.6) continue;
    const cx = Math.floor((positions[i * 3] - gx0) / cell), cz = Math.floor((positions[i * 3 + 2] - gz0) / cell);
    if (cx >= 0 && cz >= 0 && cx < W && cz < D) grid[cz * W + cx]++;
  }
  let filled = 0, total = 0;
  for (const v of grid) if (v) { filled++; total += v; }
  const solid = Math.max(2, (0.08 * total) / Math.max(filled, 1));
  const occupied = [];
  for (let c = 0; c < W * D; c++) if (grid[c] >= solid) occupied.push(c % W, Math.floor(c / W));

  const centre = (c) => [gx0 + (c[0] + 0.5) * cell, gz0 + (c[1] + 0.5) * cell];
  const candidates = [];
  for (let cz = 0; cz < D; cz++) for (let cx = 0; cx < W; cx++) {
    const [x, z] = centre([cx, cz]);
    if (x < x0 || x > x1 || z < z0 || z > z1 || grid[cz * W + cx] >= solid * 0.25) continue;
    let d2 = Infinity;
    for (let k = 0; k < occupied.length; k += 2) {
      const dx = occupied[k] - cx, dz = occupied[k + 1] - cz;
      const e = dx * dx + dz * dz;
      if (e < d2) d2 = e;
    }
    // Enclosed: looking out from here, most directions run into something.
    let hits = 0;
    for (let r = 0; r < 16; r++) {
      const ux = Math.cos((r / 16) * Math.PI * 2), uz = Math.sin((r / 16) * Math.PI * 2);
      for (let t = 1; t < W + D; t++) {
        const gx = Math.floor(cx + 0.5 + ux * t), gz = Math.floor(cz + 0.5 + uz * t);
        if (gx < 0 || gz < 0 || gx >= W || gz >= D) break;
        if (grid[gz * W + gx] >= solid) { hits++; break; }
      }
    }
    if (hits >= 13) candidates.push({ x, z, clear: Math.sqrt(d2) * cell });
  }
  candidates.sort((a, b) => b.clear - a.clear);

  const name = label || 'Captured scene';
  const lookY = eyeH * 0.8;
  // How far you can see from (x, z) along a direction before hitting something.
  const freeRun = (x, z, ux, uz) => {
    const cx = (x - gx0) / cell, cz = (z - gz0) / cell;
    for (let t = 1; t < W + D; t++) {
      const gx = Math.floor(cx + ux * t), gz = Math.floor(cz + uz * t);
      if (gx < 0 || gz < 0 || gx >= W || gz >= D || grid[gz * W + gx] >= solid) return t * cell;
    }
    return (W + D) * cell;
  };
  // Look at the middle of the capture, or (standing in the middle) down the
  // longest open view, preferring directions away from `avoid`.
  const lookFrom = (p, avoid) => {
    if (Math.hypot(p.x, p.z) > 0.8 && !avoid) return [0, lookY, 0];
    let bestDir = null, bestScore = -Infinity;
    for (let r = 0; r < 24; r++) {
      const ux = Math.cos((r / 24) * Math.PI * 2), uz = Math.sin((r / 24) * Math.PI * 2);
      let score = freeRun(p.x, p.z, ux, uz);
      if (avoid) score *= 0.6 + 0.4 * (1 - (ux * avoid[0] + uz * avoid[1])) / 2;
      if (score > bestScore) { bestScore = score; bestDir = [ux, uz]; }
    }
    return [p.x + bestDir[0] * 3, lookY, p.z + bestDir[1] * 3];
  };
  const best = candidates[0];
  if (best && best.clear >= 0.6) {
    const second = candidates.find((c) => c.clear >= 0.5 && Math.hypot(c.x - best.x, c.z - best.z) > Math.max(1.5, span * 0.25)) || best;
    const ta = lookFrom(best);
    const dirA = [ta[0] - best.x, ta[2] - best.z], la = Math.hypot(dirA[0], dirA[1]) || 1;
    const tb = second === best ? lookFrom(best, [dirA[0] / la, dirA[1] / la])
      : Math.hypot(second.x, second.z) > 0.8 ? [0, lookY, 0] : lookFrom(second, [dirA[0] / la, dirA[1] / la]);
    return [
      { name: 'Overview', blurb: `${name} — a real capture, rendered as Gaussian splats.`, pos: [best.x, eyeH, best.z], target: ta },
      { name: 'Another angle', blurb: 'The same capture from elsewhere in the space.', pos: [second.x, eyeH, second.z], target: tb },
    ];
  }
  // Object capture: step back far enough to frame it, on two sides.
  // The tour's window is about ±35° wide and ±21° tall on a 16:9 screen.
  const back = Math.max(span * 0.5 / 0.7, h * 0.5 / 0.39) * 1.3 + span * 0.5;
  const objH = h * 0.55, mid = h * 0.5;
  const stops = [
    { name: 'Front', blurb: `${name} — a real capture, rendered as Gaussian splats.`, pos: [0, objH, back], target: [0, mid, 0] },
    { name: 'Side', blurb: 'The same capture from the side.', pos: [back, objH, 0], target: [0, mid, 0] },
  ];
  stops.object = true;
  return stops;
}
