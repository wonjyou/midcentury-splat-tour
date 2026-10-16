// The room is authored directly as 3D Gaussians: every surface, cushion, leaf
// and brass ray is a cloud of anisotropic splats (flat discs on surfaces,
// needles along rods). Each splat records an albedo, a normal and a material.
//
// Lighting is then baked with a small path tracer over a voxelised copy of the
// room: ray-traced sun and lamp shadows, sky light gathered through the window
// with cosine-weighted rays, and one bounce of colour-bleeding indirect light.
// Results are linear HDR radiance, encoded per splat; the renderer adds
// view-dependent specular and tone-maps.
//
// Units are metres. y is up, the back wall is at z = ZB, the window wall at x = XL.

export const ROOM = { XL: -3.2, XR: 3.2, ZB: -4.0, ZF: 4.2, H: 2.75 };
const { XL, XR, ZB, ZF, H } = ROOM;
const WIN = { z0: -3.5, z1: 1.7, y0: 0.3, y1: 2.5, panes: 4, transom: 2.06 };
const MULL_STEP = (WIN.z1 - WIN.z0) / WIN.panes;

// Lights, shared with the renderer for specular highlights.
export const LIGHTS = {
  sunDir: norm([-0.84, 0.5, 0.2]),
  sunColor: [1.0, 0.83, 0.62],
  sunE: 13,
  lamps: [
    { p: [-0.92, 1.72, -2.3], c: [1.0, 0.64, 0.34], i: 1.5 },
    { p: [2.95, 1.25, 1.3], c: [1.0, 0.62, 0.32], i: 1.1 },
  ],
  window: { p: [XL, 1.4, (WIN.z0 + WIN.z1) / 2], c: [1.0, 0.96, 0.9] },
};

// Material ids → specular response in the renderer (see MATERIALS there).
export const MAT = { matte: 0, satin: 1, polished: 2, leather: 3, brass: 4, alu: 5, glaze: 6, fabric: 7, vinyl: 8, mirror: 9, paint: 10 };

// Colour encoding: linear radiance in [0, RANGE], stored with a 1/GAMMA curve.
export const ENCODE = { RANGE: 6, GAMMA: 2.4 };

// ---------------------------------------------------------------- math
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function basis(n) {
  const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = norm(cross(t, n));
  return [a, cross(n, a)];
}
function rot(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

let seed = 1337;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rr = (a, b) => a + (b - a) * rand();

function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return s - Math.floor(s); }
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise2(x * f, y * f); tot += amp; f *= 2.03; amp *= 0.5; }
  return s / tot;
}
const toLin = (c) => Math.pow(clamp(c, 0, 1), 2.2);

// ---------------------------------------------------------------- palette (sRGB albedo)
const C = {
  wall: [0.9, 0.87, 0.81],
  ceiling: [0.93, 0.91, 0.87],
  oak: [0.72, 0.52, 0.33],
  walnut: [0.42, 0.25, 0.14],
  walnutDark: [0.27, 0.15, 0.08],
  teal: [0.1, 0.36, 0.36],
  mustard: [0.84, 0.6, 0.16],
  rust: [0.76, 0.3, 0.13],
  cream: [0.9, 0.85, 0.75],
  linen: [0.92, 0.88, 0.8],
  leather: [0.3, 0.15, 0.08],
  bronze: [0.12, 0.1, 0.085],
  brass: [0.78, 0.58, 0.28],
  black: [0.05, 0.05, 0.05],
  alu: [0.7, 0.7, 0.72],
  marble: [0.9, 0.89, 0.86],
  leaf: [0.12, 0.3, 0.11],
};

// ---------------------------------------------------------------- splat store
const F_TWO = 1, F_OUT = 2;
class Store {
  constructor(cap) { this.n = 0; this.alloc(cap); }
  alloc(cap) {
    const f = {
      pos: new Float32Array(cap * 3), cov: new Float32Array(cap * 6), alb: new Float32Array(cap * 3),
      nrm: new Float32Array(cap * 3), emi: new Float32Array(cap), mat: new Uint8Array(cap),
      alpha: new Uint8Array(cap), flags: new Uint8Array(cap), ax: new Float32Array(cap * 6),
    };
    if (this.pos) for (const k in f) f[k].set(this[k]);
    Object.assign(this, f);
    this.cap = cap;
  }
  // Σ = Σ_k s_k² a_k a_kᵀ for three orthogonal axes a_k with std-devs s_k.
  emit(p, a1, a2, a3, s1, s2, s3, col, alpha, n, mat, emi, flags) {
    if (this.n >= this.cap) this.alloc(this.cap * 2);
    const i = this.n++;
    this.pos.set(p, i * 3);
    const q1 = s1 * s1, q2 = s2 * s2, q3 = s3 * s3, c = this.cov, o = i * 6;
    c[o] = q1 * a1[0] * a1[0] + q2 * a2[0] * a2[0] + q3 * a3[0] * a3[0];
    c[o + 1] = q1 * a1[0] * a1[1] + q2 * a2[0] * a2[1] + q3 * a3[0] * a3[1];
    c[o + 2] = q1 * a1[0] * a1[2] + q2 * a2[0] * a2[2] + q3 * a3[0] * a3[2];
    c[o + 3] = q1 * a1[1] * a1[1] + q2 * a2[1] * a2[1] + q3 * a3[1] * a3[1];
    c[o + 4] = q1 * a1[1] * a1[2] + q2 * a2[1] * a2[2] + q3 * a3[1] * a3[2];
    c[o + 5] = q1 * a1[2] * a1[2] + q2 * a2[2] * a2[2] + q3 * a3[2] * a3[2];
    this.alb[i * 3] = col[0]; this.alb[i * 3 + 1] = col[1]; this.alb[i * 3 + 2] = col[2];
    this.nrm.set(n, i * 3);
    // In-plane extents, used to voxelise surfaces without holes.
    this.ax[i * 6] = a1[0] * s1; this.ax[i * 6 + 1] = a1[1] * s1; this.ax[i * 6 + 2] = a1[2] * s1;
    this.ax[i * 6 + 3] = a2[0] * s2; this.ax[i * 6 + 4] = a2[1] * s2; this.ax[i * 6 + 5] = a2[2] * s2;
    this.emi[i] = emi;
    this.mat[i] = mat;
    this.alpha[i] = clamp(Math.round(alpha * 255), 0, 255);
    this.flags[i] = flags;
  }
}
let S;

// fn results: an sRGB albedo, null for a hole, or [r,g,b,e] to emit light with strength e.
function put(p, a1, a2, a3, s1, s2, s3, c, n, opt) {
  const e = c[3] ? (c[3] === true ? opt.emissive || 1 : c[3]) : opt.emissive || 0;
  S.emit(p, a1, a2, a3, s1, s2, s3, c, opt.alpha ?? 1, n, opt.mat ?? MAT.matte, e,
    (opt.two ? F_TWO : 0) | (opt.outdoor ? F_OUT : 0));
}

// ---------------------------------------------------------------- primitives
function rect(o, u, v, ul, vl, sp, fn, opt = {}) {
  const n = opt.normal || norm(cross(u, v));
  const [spu, spv] = Array.isArray(sp) ? sp : [sp, sp];
  const nu = Math.max(1, Math.round(ul / spu)), nv = Math.max(1, Math.round(vl / spv));
  const du = ul / nu, dv = vl / nv;
  const spread = opt.spread ?? 0.62, jit = opt.jitter ?? 0.45, th = opt.thick ?? 0.0025;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = (i + 0.5 + (rand() - 0.5) * jit) * du, b = (j + 0.5 + (rand() - 0.5) * jit) * dv;
      const p = [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b];
      const c = fn(a, b, p);
      if (!c) continue;
      put(p, u, v, n, du * spread, dv * spread, th, c, n, opt);
    }
  }
}

// Box with rounded edges (radius r) around centre c, unit axes ax[3], half extents h[3].
// Samples are laid on the box faces, then projected onto the rounded surface.
function rbox(c, ax, h, r, fn, sp, opt = {}) {
  const names = ['x', 'y', 'z'];
  const inner = h.map((v) => Math.max(v - r, 0));
  for (let k = 0; k < 3; k++) {
    for (const sg of [1, -1]) {
      const id = (sg > 0 ? '+' : '-') + names[k];
      if (opt.skip && opt.skip.includes(id)) continue;
      const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
      const n1 = Math.max(1, Math.round((2 * h[k1]) / sp)), n2 = Math.max(1, Math.round((2 * h[k2]) / sp));
      const d1 = (2 * h[k1]) / n1, d2 = (2 * h[k2]) / n2;
      for (let i = 0; i < n1; i++) {
        for (let j = 0; j < n2; j++) {
          const a = (i + 0.5 + (rand() - 0.5) * 0.4) * d1, b = (j + 0.5 + (rand() - 0.5) * 0.4) * d2;
          const q = [0, 0, 0];
          q[k] = sg * h[k]; q[k1] = a - h[k1]; q[k2] = b - h[k2];
          let lp = q, ln = [0, 0, 0];
          ln[k] = sg;
          if (r > 0) {
            const qc = [clamp(q[0], -inner[0], inner[0]), clamp(q[1], -inner[1], inner[1]), clamp(q[2], -inner[2], inner[2])];
            const d = sub(q, qc), len = Math.hypot(d[0], d[1], d[2]);
            if (len > 1e-6) { ln = mul(d, 1 / len); lp = add(qc, mul(ln, r)); }
          }
          const p = add(c, add(add(mul(ax[0], lp[0]), mul(ax[1], lp[1])), mul(ax[2], lp[2])));
          const n = norm(add(add(mul(ax[0], ln[0]), mul(ax[1], ln[1])), mul(ax[2], ln[2])));
          const col = fn(a, b, p, id);
          if (!col) continue;
          const [t1, t2] = basis(n);
          put(p, t1, t2, n, d1 * 0.62, d2 * 0.62, opt.thick ?? 0.0025, col, n, opt);
        }
      }
    }
  }
}
const obox = (c, ax, h, fn, sp, opt = {}) => rbox(c, ax, h, 0, fn, sp, opt);

function disk(c, n, r, sp, fn, opt = {}) {
  const [e1, e2] = basis(n);
  const nr = Math.max(1, Math.round(r / sp));
  const at = (p, t, rad, s1, s2) => {
    const col = fn(rad / r, p);
    if (col) put(p, t, rad > 0 ? norm(sub(p, c)) : e2, n, s1, s2, opt.thick ?? 0.0025, col, n, opt);
  };
  at(c, e1, 0, sp * 0.6, sp * 0.6);
  for (let i = 1; i <= nr; i++) {
    const rad = (i / nr) * r - (0.5 * r) / nr;
    const na = Math.max(6, Math.round((2 * Math.PI * rad) / sp));
    for (let j = 0; j < na; j++) {
      const ang = ((j + 0.5 * (i % 2)) / na) * Math.PI * 2;
      const dir = add(mul(e1, Math.cos(ang)), mul(e2, Math.sin(ang)));
      const t = add(mul(e1, -Math.sin(ang)), mul(e2, Math.cos(ang)));
      at(add(c, mul(dir, rad)), t, rad, ((2 * Math.PI * rad) / na) * 0.62, (r / nr) * 0.62);
    }
  }
}

function cylinder(base, axis, h, r0, r1, sp, fn, opt = {}) {
  const [e1, e2] = basis(axis);
  const nh = Math.max(1, Math.round(h / sp));
  for (let i = 0; i < nh; i++) {
    const t = (i + 0.5) / nh, r = r0 + (r1 - r0) * t;
    const na = Math.max(6, Math.round((2 * Math.PI * r) / sp));
    for (let j = 0; j < na; j++) {
      const ang = ((j + 0.5 * (i % 2)) / na) * Math.PI * 2;
      const dir = add(mul(e1, Math.cos(ang)), mul(e2, Math.sin(ang)));
      const tan = add(mul(e1, -Math.sin(ang)), mul(e2, Math.cos(ang)));
      const p = add(add(base, mul(axis, t * h)), mul(dir, r));
      const col = fn(t, ang, p);
      if (col) put(p, tan, axis, dir, ((2 * Math.PI * r) / na) * 0.62, (h / nh) * 0.62, 0.0025, col, dir, opt);
    }
  }
  if (opt.capTop) disk(add(base, mul(axis, h)), axis, r1, sp, (rad, p) => fn(1, rad, p), opt);
  if (opt.capBottom) disk(base, mul(axis, -1), r0, sp, (rad, p) => fn(0, rad, p), opt);
}

function ellipsoid(c, radii, sp, fn, opt = {}) {
  const ax = opt.axes || AX;
  const [a, b, cc] = radii, P = 1.6075;
  const area = 4 * Math.PI * Math.pow((Math.pow(a * b, P) + Math.pow(a * cc, P) + Math.pow(b * cc, P)) / 3, 1 / P);
  const count = Math.max(12, Math.round(area / (sp * sp)));
  const s = Math.sqrt(area / count) * 0.62;
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
    const d = [Math.cos(phi) * r, y, Math.sin(phi) * r];
    if (opt.minY !== undefined && d[1] < opt.minY) continue;
    const lp = [d[0] * a, d[1] * b, d[2] * cc];
    const p = add(c, add(add(mul(ax[0], lp[0]), mul(ax[1], lp[1])), mul(ax[2], lp[2])));
    const ln = norm([d[0] / a, d[1] / b, d[2] / cc]);
    const n = norm(add(add(mul(ax[0], ln[0]), mul(ax[1], ln[1])), mul(ax[2], ln[2])));
    const col = fn(d, p);
    if (!col) continue;
    const [t1, t2] = basis(n);
    put(p, t1, t2, n, s, s, opt.thick ?? 0.003, col, n, opt);
  }
}

// A rod along a polyline: one needle-shaped Gaussian per segment.
function tube(pts, r, fn, opt = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const seg = sub(p1, p0), len = Math.hypot(seg[0], seg[1], seg[2]);
    if (len < 1e-6) continue;
    const t = mul(seg, 1 / len), [b1, b2] = basis(t);
    const mid = mul(add(p0, p1), 0.5);
    const up = sub([0, 1, 0], mul(t, t[1]));
    const n = Math.hypot(...up) > 0.2 ? norm(up) : b1;
    put(mid, t, b1, b2, len * 0.62, r, r, fn(i / (pts.length - 1), mid), n, opt);
  }
}
function sampleCurve(f, step) {
  const pts = [f(0)];
  let prev = pts[0], t = 0;
  while (t < 1) {
    t = Math.min(1, t + 0.002);
    const p = f(t);
    if (Math.hypot(...sub(p, prev)) >= step || t >= 1) { pts.push(p); prev = p; }
  }
  return pts;
}
const bezier = (a, b, c, d) => (t) => {
  const u = 1 - t;
  return add(add(mul(a, u * u * u), mul(b, 3 * u * u * t)), add(mul(c, 3 * u * t * t), mul(d, t * t * t)));
};

// A leaf blade along `dir`, flat against `nrm`, tapering at both ends.
function leaf(base, dir, nrm, len, wid, col, opt = {}) {
  const side = norm(cross(nrm, dir));
  const m = opt.segments ?? 7;
  const droop = opt.droop ?? 0.15;
  for (let s = 0; s < m; s++) {
    const t = (s + 0.5) / m;
    const w = wid * Math.pow(Math.sin(Math.PI * Math.min(1, t * (opt.shape ?? 1.05))), 0.75) * 0.5;
    const p = add(add(base, mul(dir, len * t)), [0, -droop * len * t * t, 0]);
    const c = mul(col, (0.85 + 0.3 * rand()) * (0.9 + 0.2 * t));
    put(p, dir, side, nrm, (len / m) * 0.7, Math.max(w, 0.004), 0.0015, c, nrm, { mat: MAT.satin, two: true, ...opt.put });
  }
}

// ---------------------------------------------------------------- materials
function wood(base, along, across, s = 0, k = 1) {
  const g = fbm(along * 1.3 + s * 7.1, across * 13 * k, 3);
  const ring = 0.5 + 0.5 * Math.sin(across * 40 * k + g * 7 + s);
  const fine = (hash2(Math.floor(across * 900 * k), Math.floor(along * 6)) - 0.5) * 0.08;
  return mul(base, 0.84 + 0.2 * ring + (g - 0.5) * 0.32 + fine);
}
function fabric(base, a, b, amt = 0.07) {
  return mul(base, 1 + (fbm(a * 30, b * 30, 2) - 0.5) * amt * 2 + (hash2(Math.floor(a * 260), Math.floor(b * 260)) - 0.5) * amt);
}
function plaster(base, a, b) {
  return mul(base, 0.975 + 0.035 * fbm(a * 3, b * 3, 3) + 0.015 * (hash2(Math.floor(a * 200), Math.floor(b * 200)) - 0.5));
}
const solid = (c) => () => c;

// ---------------------------------------------------------------- room shell
function floor() {
  rect([XL, 0, ZF], [1, 0, 0], [0, 0, -1], XR - XL, ZF - ZB, 0.024, (a, b, p) => {
    const pw = 0.19, fx = (p[0] - XL) / pw, plank = Math.floor(fx);
    const off = hash2(plank, 7) * 1.6, fz = (p[2] + off) / 1.6, seg = Math.floor(fz);
    if (fx - plank < 0.04 || fz - seg < 0.008) return [0.3, 0.2, 0.12];
    const c = wood(C.oak, p[2] * 0.6, p[0] + plank * 3.1, plank, 0.6);
    return mul(c, 0.86 + 0.24 * hash2(plank, seg));
  }, { mat: MAT.satin });
}

function ceiling() {
  rect([XL, H, ZB], [1, 0, 0], [0, 0, 1], XR - XL, ZF - ZB, 0.045, (a, b, p) => plaster(C.ceiling, p[0], p[2]));
  for (let z = ZB + 0.6; z < ZF; z += 1.2) {
    rbox([0, H - 0.09, z], AX, [XR, 0.09, 0.065], 0.008, (a, b, p) => wood(C.walnut, p[0], p[2] * 2 + p[1], z), 0.03, { skip: ['+y'], mat: MAT.satin });
  }
}

function walls() {
  // Back wall: vertical walnut slats behind the sofa, painted plaster either side.
  rect([XL, 0, ZB], [1, 0, 0], [0, 1, 0], XR - XL, H, [0.013, 0.03], (a, b, p) => {
    if (Math.abs(p[0]) < 2.45) {
      const f = (p[0] + 2.45) / 0.08, slat = Math.floor(f), fs = f - slat;
      if (fs < 0.2) return [0.07, 0.04, 0.025];
      // Slight darkening toward each slat's edges reads as rounded profile.
      const edge = 0.82 + 0.18 * Math.sin(((fs - 0.2) / 0.8) * Math.PI);
      return mul(wood(C.walnut, p[1] * 0.8, p[0] * 2, slat * 1.7, 0.9), (0.9 + 0.18 * hash2(slat, 3)) * edge);
    }
    return plaster(C.wall, p[0], p[1]);
  }, { mat: MAT.paint });
  rect([XR, 0, ZB], [0, 0, 1], [0, 1, 0], ZF - ZB, H, 0.03, (a, b, p) => plaster(C.wall, p[2], p[1]), { mat: MAT.paint });
  rect([XR, 0, ZF], [-1, 0, 0], [0, 1, 0], XR - XL, H, 0.035, (a, b, p) => {
    if (p[0] > 0.9 && p[0] < 1.8 && p[1] < 2.12) {
      if (p[0] < 0.94 || p[0] > 1.76 || p[1] > 2.08) return C.walnutDark;
      return wood(C.walnut, p[1], p[0] * 2, 4);
    }
    return plaster(C.wall, p[0], p[1]);
  }, { mat: MAT.paint });
  ellipsoid([1.72, 1.02, ZF - 0.03], [0.025, 0.025, 0.025], 0.008, solid(C.brass), { mat: MAT.brass });
  rect([XL, 0, ZF], [0, 0, -1], [0, 1, 0], ZF - ZB, H, 0.035, (a, b, p) => {
    if (p[2] > WIN.z0 - 0.02 && p[2] < WIN.z1 + 0.02 && p[1] > WIN.y0 - 0.02 && p[1] < WIN.y1 + 0.02) return null;
    return plaster(C.wall, p[2], p[1]);
  }, { mat: MAT.paint });
  // Painted baseboards.
  rbox([XR - 0.008, 0.045, (ZB + ZF) / 2], AX, [0.008, 0.045, (ZF - ZB) / 2], 0.003, solid([0.88, 0.85, 0.8]), 0.02, { skip: ['+x', '-y'], mat: MAT.paint });
  rbox([0, 0.045, ZF - 0.008], AX, [XR, 0.045, 0.008], 0.003, solid([0.88, 0.85, 0.8]), 0.02, { skip: ['+z', '-y'], mat: MAT.paint });
}

function windowFrame() {
  const cy = (WIN.y0 + WIN.y1) / 2, hy = (WIN.y1 - WIN.y0) / 2, cz = (WIN.z0 + WIN.z1) / 2, hz = (WIN.z1 - WIN.z0) / 2;
  const o = { mat: MAT.satin };
  for (let k = 0; k <= WIN.panes; k++) rbox([XL, cy, WIN.z0 + k * MULL_STEP], AX, [0.05, hy, 0.025], 0.006, solid(C.bronze), 0.012, o);
  rbox([XL, WIN.y1, cz], AX, [0.05, 0.03, hz + 0.025], 0.006, solid(C.bronze), 0.012, o);
  rbox([XL, WIN.transom, cz], AX, [0.03, 0.018, hz], 0.005, solid(C.bronze), 0.012, o);
  rbox([XL + 0.08, WIN.y0 - 0.02, cz], AX, [0.12, 0.022, hz + 0.08], 0.008, (a, b, p) => wood(C.walnut, p[2], p[0] * 3, 2), 0.016, { mat: MAT.polished });
}

// Sheer linen drapes gathered at both ends of the glass, on a brass rod.
function curtains() {
  const panel = (z0, z1, folds) => {
    const sp = 0.016, nz = Math.round((z1 - z0) / sp), ny = Math.round(2.58 / 0.025);
    for (let i = 0; i < nz; i++) {
      for (let j = 0; j < ny; j++) {
        const z = z0 + ((i + 0.5 + (rand() - 0.5) * 0.4) / nz) * (z1 - z0);
        const y = 0.02 + ((j + 0.5) / ny) * 2.58;
        const ph = ((z - z0) / (z1 - z0)) * folds * Math.PI * 2;
        const amp = 0.045 * (0.85 + 0.15 * Math.sin(y * 2.1));
        const x = XL + 0.13 + amp * Math.sin(ph);
        const dxdz = amp * Math.cos(ph) * ((folds * Math.PI * 2) / (z1 - z0));
        const n = norm([1, 0, -dxdz]);
        const t = norm([dxdz, 0, 1]);
        const c = fabric(mul(C.linen, 0.9 + 0.1 * Math.sin(ph)), z * 3, y * 3, 0.05);
        put([x, y, z], t, [0, 1, 0], n, ((z1 - z0) / nz) * 0.75, (2.58 / ny) * 0.65, 0.002, c, n, { mat: MAT.fabric, two: true, alpha: 0.9 });
      }
    }
  };
  panel(WIN.z1 + 0.06, WIN.z1 + 0.62, 7);
  panel(ZB + 0.05, WIN.z0 - 0.06, 5);
  tube(sampleCurve((t) => [XL + 0.13, 2.63, ZB + 0.04 + t * (WIN.z1 + 0.7 - ZB)], 0.015), 0.011, solid(C.brass), { mat: MAT.brass });
}

// Palm Springs through the glass: pool deck, palms, and the mountains.
function exterior() {
  const out = { outdoor: true, emissive: 1.0 };
  const E = (c, s = 1) => [c[0], c[1], c[2], s];
  const BX = -18;
  rect([BX, -1, 22], [0, 0, -1], [0, 1, 0], 46, 16, 0.17, (a, b, p) => {
    const y = p[1], z = p[2];
    const ridge = 1.6 + 3.4 * fbm(z * 0.07 + 3, 1.7, 5) + 1.1 * Math.sin(z * 0.06 + 1);
    if (y < ridge) {
      const shade = fbm(z * 0.35, y * 0.6, 4);
      const rock = mix([0.5, 0.36, 0.34], [0.78, 0.6, 0.52], shade);
      return E(mix(rock, [0.95, 0.86, 0.8], smooth(ridge - 0.2, ridge + 1, y) * 0.3 + 0.18), 1.15);
    }
    const t = clamp(y / 12, 0, 1);
    return E(mix([0.98, 0.9, 0.8], [0.36, 0.58, 0.92], Math.pow(t, 0.4)), 1.6);
  }, { ...out, spread: 0.75 });

  rect([BX, -0.04, -24], [0, 0, 1], [1, 0, 0], 40, XL - BX, 0.13, (a, b, p) => {
    const x = p[0], z = p[2];
    const inPool = x > -10.4 && x < -6.6 && z > -11 && z < -2;
    const coping = x > -10.7 && x < -6.3 && z > -11.3 && z < -1.7;
    if (inPool) {
      const w = 0.5 + 0.5 * Math.sin(x * 7 + fbm(x * 2, z * 2, 3) * 9) * Math.sin(z * 5 + x);
      return E(mix([0.12, 0.5, 0.62], [0.55, 0.9, 0.95], w * 0.55), 1.2);
    }
    if (coping) return E([0.95, 0.93, 0.88], 1.35);
    if (x > -6.3) {
      const tile = Math.abs((((z / 0.9) % 1) + 1) % 1 - 0.5) > 0.48 || Math.abs((((x / 0.9) % 1) + 1) % 1 - 0.5) > 0.48;
      return E(mul([0.86, 0.82, 0.76], tile ? 0.8 : 0.97 + 0.06 * fbm(x * 3, z * 3, 2)), 1.3);
    }
    return E(mix([0.74, 0.6, 0.45], [0.9, 0.8, 0.64], fbm(x * 1.4, z * 1.4, 4)), 1.25);
  }, { ...out, spread: 0.75 });

  for (let i = 0; i < 26; i++) {
    const x = rr(-17, -11.5), z = rr(-22, 14), r = rr(0.25, 0.6);
    ellipsoid([x, r * 0.5, z], [r, r * 0.6, r], 0.08, (d) => E(mix([0.3, 0.4, 0.26], [0.55, 0.6, 0.42], rand() * 0.6 + d[1] * 0.4), 1.05), { ...out, minY: -0.2 });
  }

  const palms = [[-8.2, -13, 7.2], [-12.5, -6.5, 8.5], [-5.6, -6.2, 5.6], [-13.5, 2, 7.8], [-7.5, 3.5, 6.4], [-11, -17, 8]];
  for (const [px, pz, ht] of palms) {
    const lean = [rr(-0.6, 0.6), 0, rr(-0.6, 0.6)];
    const trunk = (t) => [px + lean[0] * t * t, ht * t, pz + lean[2] * t * t];
    tube(sampleCurve(trunk, 0.1), 0.16, (t, p) => E(mul([0.5, 0.4, 0.3], 0.75 + 0.3 * Math.abs(Math.sin(p[1] * 9))), 0.95), out);
    const top = trunk(1);
    for (let f = 0; f < 18; f++) {
      const phi = (f / 18) * Math.PI * 2 + rr(-0.15, 0.15);
      const el = rr(-0.5, 0.65);
      const dir = [Math.cos(phi) * Math.cos(el), Math.sin(el), Math.sin(phi) * Math.cos(el)];
      const L = rr(2.0, 2.8), steps = 16;
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const p = add(add(top, mul(dir, L * t)), [0, -0.9 * L * t * t, 0]);
        const tang = norm(add(dir, [0, -1.8 * t, 0]));
        const side = norm(cross(tang, [0, 1, 0]));
        const nrm = norm(cross(side, tang));
        const w = 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.1));
        const g = mix([0.16, 0.3, 0.13], [0.42, 0.52, 0.26], rand() * 0.6 + t * 0.3);
        put(p, tang, side, nrm, (L / steps) * 0.7, Math.max(w, 0.02), 0.01, E(g, 0.95), nrm, out);
      }
    }
  }
}

// ---------------------------------------------------------------- furniture
function rug() {
  const x0 = -2.1, x1 = 2.1, z0 = -3.5, z1 = -0.55;
  rect([x0, 0.01, z1], [1, 0, 0], [0, 0, -1], x1 - x0, z1 - z0, 0.017, (a, b) => {
    const edge = Math.min(a, b, x1 - x0 - a, z1 - z0 - b);
    let c;
    if (edge < 0.06) c = C.cream;
    else if (edge < 0.2) c = C.rust;
    else if (edge < 0.25) c = C.cream;
    else {
      const gu = (a - 0.25) / 0.42, gv = (b - 0.25) / 0.42;
      const fu = gu - Math.floor(gu) - 0.5, fv = gv - Math.floor(gv) - 0.5;
      const d = Math.abs(fu) + Math.abs(fv);
      const cell = (Math.floor(gu) + Math.floor(gv)) & 1;
      if (d < 0.18) c = cell ? C.mustard : C.teal;
      else if (d > 0.46 && d < 0.52) c = [0.3, 0.2, 0.14];
      else c = C.cream;
    }
    // Wool pile: per-tuft value noise, softened weave.
    return mul(fabric(c, a * 2, b * 2, 0.1), 0.92 + 0.12 * hash2(Math.floor(a * 140), Math.floor(b * 140)));
  }, { thick: 0.006, mat: MAT.fabric, spread: 0.7 });
}

function sofa() {
  const tealFab = (a, b, p) => fabric(C.teal, p[0] * 1.3, p[1] + p[2], 0.09);
  const F = { mat: MAT.fabric };
  const legs = [[-1.5, -3.85], [1.5, -3.85], [-1.5, -3.2], [1.5, -3.2]];
  for (const [x, z] of legs) cylinder([x, 0.17, z], norm([x * 0.04, -1, (z + 3.5) * 0.12]), 0.17, 0.026, 0.013, 0.009, (t, a, p) => wood(C.walnut, p[1], a, x), { mat: MAT.polished });
  rbox([0, 0.25, -3.55], AX, [1.6, 0.08, 0.42], 0.025, tealFab, 0.022, F);
  for (const x of [-1.07, 0, 1.07]) {
    rbox([x, 0.405, -3.46], AX, [0.525, 0.08, 0.375], 0.05, (a, b, p, id) => {
      // Welt piping along the cushion's top edges.
      const c = tealFab(a, b, p);
      return Math.abs(p[1] - 0.47) < 0.008 ? mul(c, 0.7) : c;
    }, 0.018, { ...F, skip: ['-y'] });
  }
  rbox([0, 0.6, -3.9], AX, [1.6, 0.32, 0.09], 0.03, tealFab, 0.022, { ...F, skip: ['-z'] });
  const tilt = rot([0, 1, 0], [1, 0, 0], -0.16), tz = rot([0, 0, 1], [1, 0, 0], -0.16);
  for (const x of [-1.07, 0, 1.07]) {
    const centre = [x, 0.68, -3.72];
    rbox(centre, [[1, 0, 0], tilt, tz], [0.515, 0.21, 0.08], 0.06, (a, b, p, id) => {
      const c = tealFab(a, b, p);
      // Two buttons per back cushion.
      const bx = p[0] - x, by = p[1] - 0.7;
      if (id === '+z' && (Math.hypot(bx - 0.22, by) < 0.016 || Math.hypot(bx + 0.22, by) < 0.016)) return mul(c, 0.55);
      return c;
    }, 0.018, { ...F, skip: ['-z'] });
  }
  for (const sx of [-1, 1]) rbox([sx * 1.56, 0.42, -3.5], AX, [0.06, 0.13, 0.44], 0.02, (a, b, p) => wood(C.walnut, p[2], p[1] * 3, sx), 0.016, { mat: MAT.polished });
  const pil = (at, yaw, color, sz = [0.22, 0.2, 0.075]) => {
    const ax0 = rot([1, 0, 0], [0, 1, 0], yaw), ax2 = rot(rot([0, 0, 1], [0, 1, 0], yaw), ax0, -0.35);
    const ax1 = norm(cross(ax2, ax0));
    rbox(at, [ax0, ax1, ax2], sz, sz[2] * 0.95, (a, b, p) => fabric(color, a * 3, b * 3, 0.1), 0.016, { ...F, axes: undefined });
  };
  pil([-1.16, 0.67, -3.57], 0.3, C.mustard);
  pil([1.2, 0.67, -3.57], -0.25, C.rust);
  pil([0.86, 0.63, -3.5], -0.1, C.cream, [0.19, 0.17, 0.07]);
}

function coffeeTable() {
  const cx = 0, cz = -2.0, rx = 0.66, rz = 0.36, top = 0.4, th = 0.035;
  const woodTop = (p) => wood(C.walnut, p[0] * 1.2, p[2] * 2, 11);
  for (const [y, n] of [[top, [0, 1, 0]], [top - th, [0, -1, 0]]]) {
    const sp = 0.016;
    for (let x = -rx; x <= rx; x += sp) {
      for (let z = -rz; z <= rz; z += sp) {
        const jx = x + (rand() - 0.5) * sp * 0.4, jz = z + (rand() - 0.5) * sp * 0.4;
        const e = (jx * jx) / (rx * rx) + (jz * jz) / (rz * rz);
        if (e > 1) continue;
        // Rounded edge: the outer rim rolls down toward the band.
        const roll = smooth(0.9, 1.0, e);
        const p = [cx + jx, y - (n[1] > 0 ? roll * 0.01 : 0), cz + jz];
        const nn = norm(add(n, mul([jx / rx, 0, jz / rz], roll * 0.9)));
        put(p, [1, 0, 0], [0, 0, 1], nn, sp * 0.62, sp * 0.62, 0.0025, woodTop(p), nn, { mat: MAT.polished });
      }
    }
  }
  const ne = Math.round((2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2)) / 0.01);
  for (let i = 0; i < ne; i++) {
    for (const yo of [0.33, 0.67]) {
      const a = (i / ne) * Math.PI * 2;
      const p = [cx + Math.cos(a) * rx, top - th * yo, cz + Math.sin(a) * rz];
      const n = norm([Math.cos(a) / rx, 0, Math.sin(a) / rz]);
      put(p, norm([-n[2], 0, n[0]]), [0, 1, 0], n, 0.007, th * 0.2, 0.0025, mul(C.walnutDark, 1.1), n, { mat: MAT.polished });
    }
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    cylinder([cx + sx * 0.42, top - th, cz + sz * 0.17], norm([sx * 0.18, -1, sz * 0.12]), 0.37, 0.022, 0.012, 0.009, (t, a, p) => wood(C.walnut, p[1], a, sx + sz), { mat: MAT.polished });
  }
  const books = [[C.rust, 0.03], [[0.12, 0.28, 0.32], 0.025], [C.cream, 0.02]];
  let y = top;
  books.forEach(([col, h], i) => {
    const yaw = 0.15 * i - 0.1;
    rbox([-0.3, y + h / 2, -1.96], [rot([1, 0, 0], [0, 1, 0], yaw), [0, 1, 0], rot([0, 0, 1], [0, 1, 0], yaw)], [0.15, h / 2, 0.11], 0.003,
      (a, b, p, id) => (id === '+x' || id === '-z' || id === '+z' ? [0.92, 0.89, 0.82] : col), 0.01, { skip: ['-y'], mat: MAT.satin });
    y += h;
  });
  ellipsoid([0.27, top + 0.06, -2.02], [0.13, 0.065, 0.13], 0.012, () => C.rust, { minY: -1, mat: MAT.glaze });
  ellipsoid([0.27, top + 0.115, -2.02], [0.115, 0.004, 0.115], 0.012, () => [0.4, 0.15, 0.07], { mat: MAT.glaze });
  for (const [dx, dz, col] of [[0.0, 0.0, [0.5, 0.62, 0.16]], [0.06, 0.04, [0.88, 0.66, 0.12]], [-0.05, 0.05, [0.58, 0.66, 0.18]]]) {
    ellipsoid([0.27 + dx, top + 0.14, -2.02 + dz], [0.04, 0.04, 0.04], 0.009, () => col, { mat: MAT.glaze });
  }
}

function loungeChair() {
  const Cc = [2.0, 0, -2.3];
  const Z = norm([0.8, 0, -0.6]), Y = [0, 1, 0], X = norm(cross(Y, Z));
  const L = (x, y, z) => add(Cc, add(add(mul(X, x), mul(Y, y)), mul(Z, z)));
  const tilted = (th) => [X, add(mul(Y, Math.cos(th)), mul(Z, Math.sin(th))), add(mul(Y, -Math.sin(th)), mul(Z, Math.cos(th)))];
  const shellFn = (a, b, p) => wood(C.walnut, p[1] + p[0], (p[2] - p[0]) * 2, 5);
  const leatherFn = (a, b, p) => fabric(C.leather, p[0] + p[2], p[1], 0.14);
  const piece = (centre, th, shellH, cushH, cushOff, cushAxis) => {
    const ax = tilted(th);
    rbox(centre, ax, shellH, 0.02, shellFn, 0.016, { mat: MAT.polished });
    rbox(add(centre, mul(ax[cushAxis], cushOff)), ax, cushH, 0.045, leatherFn, 0.016, { mat: MAT.leather });
  };
  piece(L(0, 0.38, 0.02), 0.1, [0.41, 0.022, 0.37], [0.37, 0.058, 0.33], 0.075, 1);
  piece(L(0, 0.78, 0.36), 0.34, [0.41, 0.3, 0.022], [0.37, 0.27, 0.058], -0.075, 2);
  piece(L(0, 1.16, 0.5), 0.42, [0.39, 0.11, 0.022], [0.35, 0.095, 0.052], -0.07, 2);
  for (const sx of [-1, 1]) {
    rbox(L(sx * 0.44, 0.6, -0.02), [X, Y, Z], [0.045, 0.028, 0.24], 0.022, leatherFn, 0.012, { mat: MAT.leather });
    tube([L(sx * 0.44, 0.58, 0.05), L(sx * 0.42, 0.42, 0.12)], 0.012, solid(C.black), { mat: MAT.alu });
  }
  cylinder(L(0, 0.06, 0.06), Y, 0.28, 0.04, 0.035, 0.01, solid(C.black), { mat: MAT.vinyl });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const end = L(Math.cos(a) * 0.38, 0.03, 0.06 + Math.sin(a) * 0.38);
    tube(sampleCurve((t) => mix(L(0, 0.08, 0.06), end, t), 0.015), 0.02, solid(C.alu), { mat: MAT.alu });
  }
  const O = (x, y, z) => L(x, y, z - 0.92);
  const oax = tilted(-0.1);
  rbox(O(0, 0.33, 0), oax, [0.33, 0.022, 0.26], 0.02, shellFn, 0.016, { mat: MAT.polished });
  rbox(O(0, 0.39, 0), oax, [0.31, 0.055, 0.24], 0.045, leatherFn, 0.016, { skip: ['-y'], mat: MAT.leather });
  cylinder(O(0, 0.05, 0), Y, 0.26, 0.035, 0.03, 0.01, solid(C.black), { mat: MAT.vinyl });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    tube(sampleCurve((t) => mix(O(0, 0.07, 0), O(Math.cos(a) * 0.3, 0.03, Math.sin(a) * 0.3), t), 0.015), 0.018, solid(C.alu), { mat: MAT.alu });
  }
}

function credenza() {
  const c = [2.945, 0.49, 0.6], h = [0.225, 0.29, 1.0];
  rbox(c, AX, h, 0.008, (a, b, p, id) => {
    if (id === '-x') {
      const f = b / 0.5, door = Math.floor(f), fd = f - door;
      if (fd < 0.02 || fd > 0.98 || a < 0.02 || a > 0.56) return [0.1, 0.06, 0.035];
      if ((door === 1 || door === 2) && fd > 0.1 && fd < 0.9 && a > 0.07 && a < 0.51) {
        const w = (Math.floor(a / 0.009) + Math.floor(b / 0.009)) & 1;
        return mul([0.8, 0.68, 0.48], w ? 0.92 : 0.62);
      }
      const pull = door < 2 ? 0.88 : 0.12;
      if (Math.abs(fd - pull) < 0.025 && Math.abs(a - 0.33) < 0.06) return [0.08, 0.05, 0.03];
      return wood(C.walnut, p[2] * 1.4, p[1] * 3, door);
    }
    return wood(C.walnut, p[2] * 1.4, (p[0] + p[1]) * 3, 9);
  }, 0.013, { skip: ['+x'], mat: MAT.polished });
  for (const [x, z] of [[2.78, -0.32], [3.12, -0.32], [2.78, 1.52], [3.12, 1.52]]) {
    cylinder([x, 0.2, z], [0, -1, 0], 0.2, 0.024, 0.013, 0.009, (t, a, p) => wood(C.walnut, p[1], a, x), { mat: MAT.polished });
  }
  rbox([2.93, 0.82, 0.08], AX, [0.17, 0.04, 0.21], 0.008, (a, b, p) => wood(C.walnutDark, p[2], p[0] * 4, 3), 0.011, { skip: ['-y'], mat: MAT.polished });
  disk([2.93, 0.862, 0.05], [0, 1, 0], 0.15, 0.009, (r) => (r < 0.27 ? [0.72, 0.18, 0.1] : mul([0.05, 0.05, 0.06], 0.85 + 0.3 * Math.abs(Math.sin(r * 90)))), { mat: MAT.vinyl });
  tube([[3.06, 0.87, 0.24], [3.04, 0.89, 0.1], [2.98, 0.88, 0.0]], 0.006, solid(C.alu), { mat: MAT.alu });
  // Ceramic lamp with a glowing linen drum shade.
  ellipsoid([2.95, 0.94, 1.3], [0.1, 0.16, 0.1], 0.011, (d) => mul(C.mustard, 0.85 + 0.2 * d[1]), { mat: MAT.glaze });
  tube([[2.95, 1.09, 1.3], [2.95, 1.16, 1.3]], 0.012, solid(C.brass), { mat: MAT.brass });
  cylinder([2.95, 1.12, 1.3], [0, 1, 0], 0.24, 0.22, 0.16, 0.014, (t) => [1.0, 0.86, 0.66, 2.2 + 1.4 * (1 - t)], { two: true });
  // Snake plant in a terracotta pot.
  cylinder([2.95, 0.78, -0.15], [0, 1, 0], 0.17, 0.08, 0.1, 0.011, () => [0.68, 0.36, 0.22]);
  disk([2.95, 0.94, -0.15], [0, 1, 0], 0.095, 0.015, () => [0.15, 0.1, 0.06]);
  for (let i = 0; i < 13; i++) {
    const a = rr(0, Math.PI * 2), tilt = rr(0.02, 0.28);
    const dir = norm([Math.cos(a) * tilt, 1, Math.sin(a) * tilt]);
    const nrm = norm(cross(dir, [Math.cos(a + 1.6), 0, Math.sin(a + 1.6)]));
    leaf([2.95 + Math.cos(a) * 0.04, 0.93, -0.15 + Math.sin(a) * 0.04], dir, nrm, rr(0.38, 0.62), 0.06, [0.2, 0.38, 0.16], { droop: 0, segments: 10, shape: 1.0 });
  }
}

function art() {
  const z0 = -0.1, z1 = 1.3, y0 = 1.23, y1 = 2.13;
  rbox([XR - 0.025, (y0 + y1) / 2, (z0 + z1) / 2], AX, [0.02, (y1 - y0) / 2, (z1 - z0) / 2], 0.004, (a, b, p, id) => {
    if (id !== '-x') return C.walnutDark;
    const u = p[2] - z0, v = p[1] - y0;
    if (u < 0.03 || u > z1 - z0 - 0.03 || v < 0.03 || v > y1 - y0 - 0.03) return C.walnutDark;
    let c = mul(C.cream, 0.96 + 0.06 * fbm(u * 20, v * 20, 2));
    if (Math.hypot(u - 0.42, v - 0.52) < 0.2) c = C.rust;
    if (Math.hypot(u - 0.92, v - 0.18) < 0.28 && v > 0.18) c = C.teal;
    if (u > 0.74 && u < 1.22 && v > 0.56 && v < 0.74) c = C.mustard;
    if (Math.abs(v - 0.42) < 0.006 && u > 0.12 && u < 1.1) c = [0.06, 0.05, 0.05];
    if (Math.hypot(u - 0.24, v - 0.24) < 0.05) c = [0.06, 0.05, 0.05];
    // Brush texture.
    return mul(c, 0.94 + 0.1 * fbm(u * 60, v * 8, 2));
  }, 0.01, { skip: ['+x'] });
}

function sunburst() {
  const c = [0, 1.9, ZB + 0.04];
  disk(add(c, [0, 0, -0.005]), [0, 0, 1], 0.2, 0.009, (r) => mul(C.brass, 0.85 + 0.2 * Math.sin(r * 30)), { mat: MAT.brass });
  disk(add(c, [0, 0, 0.006]), [0, 0, 1], 0.155, 0.009, (r, p) => mix([0.55, 0.56, 0.56], [0.3, 0.27, 0.24], smooth(-0.15, 0.15, p[1] - c[1]) * 0.7 + r * 0.2), { mat: MAT.mirror });
  const rays = 32;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const len = i % 2 ? 0.36 : 0.52;
    const d = [Math.cos(a), Math.sin(a), 0];
    tube(sampleCurve((t) => add(c, mul(d, 0.2 + t * (len - 0.2))), 0.01), 0.006, () => C.brass, { mat: MAT.brass });
    ellipsoid(add(c, mul(d, len)), [0.016, 0.016, 0.016], 0.007, () => C.brass, { mat: MAT.brass });
  }
}

function glow(c, r, count, strength) {
  for (let i = 0; i < count; i++) {
    const p = add(c, [rr(-r, r) * 0.4, rr(-r, r) * 0.4, rr(-r, r) * 0.4]);
    const s = rr(0.06, r * 1.6);
    S.emit(p, [1, 0, 0], [0, 1, 0], [0, 0, 1], s, s, s, [1.0, 0.72, 0.42], rr(0.025, 0.05), [0, 1, 0], MAT.matte, strength, F_OUT);
  }
}

function arcLamp() {
  const base = [-2.35, 0, -3.3];
  cylinder(base, [0, 1, 0], 0.07, 0.17, 0.165, 0.01, (t, a, p) => {
    const v = fbm(p[0] * 18, p[2] * 18 + p[1] * 10, 4);
    return mul(C.marble, Math.abs(v - 0.5) < 0.02 ? 0.72 : 0.94 + 0.08 * v);
  }, { capTop: true, mat: MAT.glaze });
  const curve = bezier([-2.35, 0.07, -3.3], [-2.42, 2.45, -3.32], [-1.08, 2.5, -2.45], [-0.92, 1.88, -2.3]);
  tube(sampleCurve(curve, 0.01), 0.012, () => C.brass, { mat: MAT.brass });
  ellipsoid([-0.92, 1.88, -2.3], [0.04, 0.03, 0.04], 0.008, solid(C.brass), { mat: MAT.brass });
  ellipsoid([-0.92, 1.72, -2.3], [0.16, 0.16, 0.16], 0.012, (d) => [1.0, 0.92, 0.8, 5.5 + 1.0 * d[1]]);
  glow([-0.92, 1.72, -2.3], 0.2, 30, 0.9);
}

function fiddleLeafFig() {
  const P = [-2.55, 0, 0.5];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    tube(sampleCurve((t) => mix(add(P, [Math.cos(a) * 0.12, 0.14, Math.sin(a) * 0.12]), add(P, [Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2]), t), 0.012), 0.009, solid(C.brass), { mat: MAT.brass });
  }
  cylinder(add(P, [0, 0.12, 0]), [0, 1, 0], 0.4, 0.16, 0.2, 0.012, () => [0.88, 0.86, 0.82], { mat: MAT.glaze });
  disk(add(P, [0, 0.5, 0]), [0, 1, 0], 0.19, 0.015, () => [0.16, 0.1, 0.06]);
  const stems = [[1.55, 0.1, 0.05], [1.8, -0.12, -0.04], [1.3, 0.02, 0.16]];
  for (const [ht, lx, lz] of stems) {
    const stem = (t) => add(P, [lx * t * t * 2, 0.5 + (ht - 0.5) * t, lz * t * t * 2]);
    tube(sampleCurve(stem, 0.015), 0.011, solid([0.32, 0.25, 0.15]));
    const nLeaves = Math.round(ht * 16);
    for (let i = 0; i < nLeaves; i++) {
      const t = 0.3 + 0.7 * (i / nLeaves) + rr(-0.02, 0.02);
      const at = stem(t);
      const phi = i * 2.4 + rr(-0.3, 0.3);
      const dir = norm([Math.cos(phi), rr(0.3, 0.9), Math.sin(phi)]);
      const side = norm(cross([0, 1, 0], dir));
      const nrm = norm(rot(cross(dir, side), dir, rr(-0.5, 0.5)));
      const size = rr(0.18, 0.27) * (1.1 - t * 0.3);
      leaf(at, dir, nrm, size, size * 0.72, mix(C.leaf, [0.2, 0.4, 0.14], rand()), { droop: 0.25, segments: 8 });
    }
  }
}

// ---------------------------------------------------------------- light baking
const VOX = 0.05;
const GX0 = XL - 0.1, GY0 = -0.1, GZ0 = ZB - 0.1;
const NX = Math.ceil((XR - XL + 0.2) / VOX), NY = Math.ceil((H + 0.2) / VOX), NZ = Math.ceil((ZF - ZB + 0.2) / VOX);
const IV = 1 / VOX;

function skyRadiance(d) {
  if (d[1] > 0) {
    const t = Math.pow(d[1], 0.5);
    return mix([1.5, 1.38, 1.22], [0.55, 0.75, 1.15], t);
  }
  return [1.45, 1.22, 0.95]; // sunlit deck and desert
}

function bake(progress) {
  const n = S.n, pos = S.pos, nrm = S.nrm, alb = S.alb, flags = S.flags, emi = S.emi;
  const occ = new Uint8Array(NX * NY * NZ);
  const vB = new Float32Array(NX * NY * NZ * 3);   // first-bounce radiance per voxel
  const vA = new Float32Array(NX * NY * NZ * 3);   // mean albedo per voxel
  const vN = new Uint16Array(NX * NY * NZ);
  const vox = (x, y, z) => {
    const ix = ((x - GX0) * IV) | 0, iy = ((y - GY0) * IV) | 0, iz = ((z - GZ0) * IV) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ) return -1;
    return (iz * NY + iy) * NX + ix;
  };
  const lin = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) lin[i] = toLin(alb[i]);

  // Voxelise the interior (centre plus in-plane extents so surfaces have no gaps).
  const ax = S.ax;
  for (let i = 0; i < n; i++) {
    if (flags[i] & F_OUT) continue;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    for (let k = 0; k < 5; k++) {
      let ox = 0, oy = 0, oz = 0;
      if (k > 0) {
        const o = k < 3 ? 0 : 3, s = k % 2 ? 1 : -1;
        ox = ax[i * 6 + o] * s; oy = ax[i * 6 + o + 1] * s; oz = ax[i * 6 + o + 2] * s;
      }
      const v = vox(x + ox, y + oy, z + oz);
      if (v >= 0) occ[v] = 1;
    }
  }

  const STEP = VOX * 0.9;
  // Returns: voxel index on hit, -1 through the window, -2 blocked elsewhere, -3 nothing within tmax.
  function march(ox, oy, oz, dx, dy, dz, tmax) {
    for (let t = 0.0; t < tmax; t += STEP) {
      const x = ox + dx * t;
      if (x < XL - 0.04) {
        const tc = (XL - ox) / dx, yc = oy + dy * tc, zc = oz + dz * tc;
        if (yc > WIN.y0 && yc < WIN.y1 && zc > WIN.z0 && zc < WIN.z1) {
          const m = (zc - WIN.z0) / MULL_STEP;
          if (Math.abs(m - Math.round(m)) * MULL_STEP < 0.03 || Math.abs(yc - WIN.transom) < 0.02) return -2;
          return -1;
        }
        return -2;
      }
      const v = vox(x, oy + dy * t, oz + dz * t);
      if (v < 0) return -2;
      if (occ[v]) return v;
    }
    return -3;
  }

  const L = LIGHTS, sd = L.sunDir;
  const sunCone = [[0, 0, 0], [0.02, 0.015, 0], [-0.015, -0.02, 0.02]].map((o) => norm(add(sd, o)));
  const direct = new Float32Array(n * 3);
  const sunVis = new Float32Array(n);
  const OFF = 0.075;

  // Pass 1: direct sun and lamps with ray-traced shadows.
  for (let i = 0; i < n; i++) {
    if (i % 20000 === 0) progress?.(0.1 + 0.3 * (i / n), 'Tracing sunlight');
    if ((flags[i] & F_OUT) || emi[i] > 0) continue;
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    const two = flags[i] & F_TWO;
    let er = 0, eg = 0, eb = 0;
    let ndl = nx * sd[0] + ny * sd[1] + nz * sd[2];
    if (two && ndl < 0) { ndl = -ndl * 0.6; } // thin leaves and linen transmit some light
    if (ndl > 0) {
      const sgn = two && nx * sd[0] + ny * sd[1] + nz * sd[2] < 0 ? -1 : 1;
      const ox = px + nx * OFF * sgn, oy = py + ny * OFF * sgn, oz = pz + nz * OFF * sgn;
      let vis = 0;
      for (const d of sunCone) if (march(ox, oy, oz, d[0], d[1], d[2], 12) === -1) vis++;
      vis /= sunCone.length;
      sunVis[i] = vis;
      const e = L.sunE * ndl * vis;
      er += e * L.sunColor[0]; eg += e * L.sunColor[1]; eb += e * L.sunColor[2];
    }
    for (const lamp of L.lamps) {
      const dx = lamp.p[0] - px, dy = lamp.p[1] - py, dz = lamp.p[2] - pz;
      const dist = Math.hypot(dx, dy, dz), ix = dx / dist, iy = dy / dist, iz = dz / dist;
      let c = nx * ix + ny * iy + nz * iz;
      if (two) c = Math.abs(c);
      if (c <= 0) continue;
      const r = march(px + nx * OFF, py + ny * OFF, pz + nz * OFF, ix, iy, iz, dist - 0.32); // stop short of the lamp's own globe/shade
      if (r !== -3) continue;
      const e = (lamp.i * c) / (dist * dist + 0.04);
      er += e * lamp.c[0]; eg += e * lamp.c[1]; eb += e * lamp.c[2];
    }
    direct[i * 3] = er; direct[i * 3 + 1] = eg; direct[i * 3 + 2] = eb;
  }

  // Splat radiance into voxels for the bounce gather.
  for (let i = 0; i < n; i++) {
    if (flags[i] & F_OUT) continue;
    const v = vox(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (v < 0) continue;
    for (let k = 0; k < 3; k++) {
      const a = lin[i * 3 + k];
      vB[v * 3 + k] += emi[i] > 0 ? a * emi[i] : (a * direct[i * 3 + k]) / Math.PI;
      vA[v * 3 + k] += a;
    }
    vN[v]++;
  }
  for (let v = 0; v < vN.length; v++) {
    if (!vN[v]) continue;
    const k = 1 / vN[v];
    for (let c = 0; c < 3; c++) { vB[v * 3 + c] *= k; vA[v * 3 + c] *= k; }
  }

  // Pass 2: gather sky + first bounce with stratified cosine-weighted rays.
  const RAYS_U = 5, RAYS_V = 4, RAYS = RAYS_U * RAYS_V;
  const AMB = [0.1, 0.095, 0.085]; // stands in for the second and later bounces
  const ind = new Float32Array(n * 3);
  const skyVis = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i % 20000 === 0) progress?.(0.4 + 0.45 * (i / n), 'Gathering bounce light');
    if ((flags[i] & F_OUT) || emi[i] > 0) continue;
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    const N = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
    const [t1, t2] = basis(N);
    const ox = px + N[0] * OFF, oy = py + N[1] * OFF, oz = pz + N[2] * OFF;
    let r = 0, g = 0, b = 0, sky = 0;
    for (let u = 0; u < RAYS_U; u++) {
      for (let w = 0; w < RAYS_V; w++) {
        const r1 = (u + rand()) / RAYS_U, r2 = (w + rand()) / RAYS_V;
        const phi = 2 * Math.PI * r1, sr = Math.sqrt(r2), cz = Math.sqrt(1 - r2);
        const cx = Math.cos(phi) * sr, cy = Math.sin(phi) * sr;
        const dx = t1[0] * cx + t2[0] * cy + N[0] * cz;
        const dy = t1[1] * cx + t2[1] * cy + N[1] * cz;
        const dz = t1[2] * cx + t2[2] * cy + N[2] * cz;
        const hit = march(ox, oy, oz, dx, dy, dz, 4.5);
        if (hit >= 0) {
          r += vB[hit * 3] + vA[hit * 3] * AMB[0];
          g += vB[hit * 3 + 1] + vA[hit * 3 + 1] * AMB[1];
          b += vB[hit * 3 + 2] + vA[hit * 3 + 2] * AMB[2];
        } else if (hit === -1) {
          const s = skyRadiance([dx, dy, dz]);
          r += s[0]; g += s[1]; b += s[2]; sky++;
        } else {
          r += AMB[0] * 0.8; g += AMB[1] * 0.8; b += AMB[2] * 0.8;
        }
      }
    }
    // Irradiance from a cosine-weighted estimate: E = π · mean(L).
    const k = Math.PI / RAYS;
    ind[i * 3] = r * k; ind[i * 3 + 1] = g * k; ind[i * 3 + 2] = b * k;
    skyVis[i] = sky / RAYS;
  }

  // Denoise the gathered light: average over a 30 cm neighbourhood of splats
  // that face the same way, then blend with each splat's own estimate.
  progress?.(0.88, 'Denoising');
  const DC = 0.1, DX = Math.ceil(NX * VOX / DC) + 1, DY = Math.ceil(NY * VOX / DC) + 1, DZ = Math.ceil(NZ * VOX / DC) + 1;
  const dsum = new Float32Array(DX * DY * DZ * 6 * 4);
  const bin = (i) => {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2];
    const ax_ = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ax_ >= ay && ax_ >= az) return x > 0 ? 0 : 1;
    if (ay >= az) return y > 0 ? 2 : 3;
    return z > 0 ? 4 : 5;
  };
  const cell = (i) => [((pos[i * 3] - GX0) / DC) | 0, ((pos[i * 3 + 1] - GY0) / DC) | 0, ((pos[i * 3 + 2] - GZ0) / DC) | 0];
  for (let i = 0; i < n; i++) {
    if ((flags[i] & F_OUT) || emi[i] > 0) continue;
    const [cx, cy, cz] = cell(i);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= DX || cy >= DY || cz >= DZ) continue;
    const o = (((cz * DY + cy) * DX + cx) * 6 + bin(i)) * 4;
    dsum[o] += ind[i * 3]; dsum[o + 1] += ind[i * 3 + 1]; dsum[o + 2] += ind[i * 3 + 2]; dsum[o + 3]++;
  }

  // Encode final radiance.
  progress?.(0.94, 'Developing');
  const out = new Uint8Array(n * 4);
  const normals = new Uint32Array(n);
  const extra = new Uint32Array(n);
  const { RANGE, GAMMA } = ENCODE;
  const enc = (x) => clamp(Math.round(Math.pow(clamp(x / RANGE, 0, 1), 1 / GAMMA) * 255), 0, 255);
  for (let i = 0; i < n; i++) {
    let R, G, B;
    if (emi[i] > 0) {
      R = lin[i * 3] * emi[i]; G = lin[i * 3 + 1] * emi[i]; B = lin[i * 3 + 2] * emi[i];
    } else {
      let ir = ind[i * 3], ig = ind[i * 3 + 1], ib = ind[i * 3 + 2];
      const [cx, cy, cz] = cell(i), bn = bin(i);
      let sr = 0, sg = 0, sb = 0, sc = 0;
      for (let z = cz - 1; z <= cz + 1; z++) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || z < 0 || x >= DX || y >= DY || z >= DZ) continue;
        const o = (((z * DY + y) * DX + x) * 6 + bn) * 4;
        sr += dsum[o]; sg += dsum[o + 1]; sb += dsum[o + 2]; sc += dsum[o + 3];
      }
      if (sc > 0) {
        ir = ir * 0.12 + (sr / sc) * 0.88; ig = ig * 0.12 + (sg / sc) * 0.88; ib = ib * 0.12 + (sb / sc) * 0.88;
      }
      const k = 1 / Math.PI;
      R = lin[i * 3] * (direct[i * 3] + ir) * k;
      G = lin[i * 3 + 1] * (direct[i * 3 + 1] + ig) * k;
      B = lin[i * 3 + 2] * (direct[i * 3 + 2] + ib) * k;
    }
    out[i * 4] = enc(R); out[i * 4 + 1] = enc(G); out[i * 4 + 2] = enc(B); out[i * 4 + 3] = S.alpha[i];
    const q = (v) => clamp(Math.round((v * 0.5 + 0.5) * 1023), 0, 1023);
    normals[i] = (q(nrm[i * 3]) | (q(nrm[i * 3 + 1]) << 10) | (q(nrm[i * 3 + 2]) << 20)) >>> 0;
    extra[i] = (S.mat[i] | (Math.round(sunVis[i] * 255) << 8) | (Math.round(clamp(skyVis[i] * 3, 0, 1) * 255) << 16)) >>> 0;
  }
  return { colors: out, normals, extra };
}

export function buildRoom(progress) {
  S = new Store(400000);
  seed = 1337;
  progress?.(0.02, 'Placing Gaussians');
  floor();
  ceiling();
  walls();
  windowFrame();
  curtains();
  exterior();
  rug();
  sofa();
  coffeeTable();
  loungeChair();
  credenza();
  art();
  sunburst();
  arcLamp();
  fiddleLeafFig();
  const lit = bake(progress);
  const n = S.n;
  return {
    count: n,
    positions: S.pos.slice(0, n * 3),
    covariances: S.cov.slice(0, n * 6),
    colors: lit.colors,
    normals: lit.normals,
    extra: lit.extra,
  };
}
