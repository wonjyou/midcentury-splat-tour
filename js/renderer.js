// A small WebGL2 3D Gaussian splat renderer with an HDR camera pipeline.
//
// Every splat is a 3D Gaussian (center, 3x3 covariance, baked HDR radiance,
// normal, material). The vertex shader projects the covariance to a 2D ellipse
// (EWA splatting via the projection Jacobian) and adds view-dependent specular
// for glossy materials, so highlights slide across the floor and brass as the
// head moves. Splats are composited front-to-back into a half-float buffer,
// then bloom, ACES tone mapping, vignette and grain finish the frame.

import { ENCODE } from './scene.js';

const MATERIALS = [
  // specular strength, shininess, metallic
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

const SPLAT_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_data;
uniform mat4 u_view, u_proj;
uniform vec2 u_focal, u_viewport;
uniform vec3 u_revealOrigin;
uniform float u_reveal;
uniform vec3 u_eye, u_sunDir, u_sunCol, u_winPos, u_winCol;
uniform vec3 u_lampPos[2], u_lampCol[2];
uniform vec4 u_mat[${MATERIALS.length}];

in vec2 a_quad;
in uint a_index;
out vec4 v_color;
out vec2 v_pos;

const float PI = 3.14159265;

void main() {
  // 3 texels per splat: [center.xyz, rgba8] [cov xx xy xz yy] [cov yz zz, normal, material]
  ivec2 base = ivec2(int(a_index & 1023u) * 3, int(a_index >> 10u));
  uvec4 t0 = texelFetch(u_data, base, 0);
  vec3 center = uintBitsToFloat(t0.xyz);

  vec4 cam = u_view * vec4(center, 1.0);
  float d = -cam.z;
  vec4 clip = u_proj * cam;
  float lim = 1.25 * clip.w;
  if (d < 0.04 || clip.x < -lim || clip.x > lim || clip.y < -lim || clip.y > lim) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec4 c1 = uintBitsToFloat(texelFetch(u_data, base + ivec2(1, 0), 0));
  uvec4 t2 = texelFetch(u_data, base + ivec2(2, 0), 0);
  vec2 c2 = uintBitsToFloat(t2.xy);
  mat3 V = mat3(c1.x, c1.y, c1.z, c1.y, c1.w, c2.x, c1.z, c2.x, c2.y);

  float id = 1.0 / d;
  mat3 J = mat3(u_focal.x * id, 0.0, 0.0,
                0.0, u_focal.y * id, 0.0,
                u_focal.x * cam.x * id * id, u_focal.y * cam.y * id * id, 0.0);
  mat3 T = J * mat3(u_view);
  mat3 cov = T * V * transpose(T);
  float a = cov[0][0] + 0.3, b = cov[0][1], c = cov[1][1] + 0.3;
  float mid = 0.5 * (a + c);
  float rad = length(vec2(0.5 * (a - c), b));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 dir = (abs(b) < 1e-7) ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dir.y, -dir.x);

  vec4 enc = vec4(float(t0.w & 255u), float((t0.w >> 8u) & 255u), float((t0.w >> 16u) & 255u), float(t0.w >> 24u)) / 255.0;
  vec3 col = pow(enc.rgb, vec3(${ENCODE.GAMMA.toFixed(2)})) * ${ENCODE.RANGE.toFixed(2)};

  // View-dependent specular (normalised Blinn-Phong with Schlick Fresnel).
  vec4 m = u_mat[t2.w & 255u];
  if (m.x > 0.0) {
    vec3 N = normalize(vec3(float(t2.z & 1023u), float((t2.z >> 10u) & 1023u), float((t2.z >> 20u) & 1023u)) / 1023.0 * 2.0 - 1.0);
    vec3 Vd = normalize(u_eye - center);
    if (dot(N, Vd) < 0.0) N = -N;
    float NV = max(dot(N, Vd), 1e-3);
    float sunVis = float((t2.w >> 8u) & 255u) / 255.0;
    float skyVis = float((t2.w >> 16u) & 255u) / 255.0;
    vec3 tint = col / max(max(col.r, col.g), max(col.b, 1e-4));
    vec3 F0 = mix(vec3(0.04), tint * 0.9, m.z);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - NV, 5.0);
    float sh = m.y, nrm = (sh + 8.0) / (8.0 * PI);
    vec3 s = vec3(0.0);
    vec3 L = u_sunDir;
    s += u_sunCol * sunVis * max(dot(N, L), 0.0) * pow(max(dot(N, normalize(L + Vd)), 0.0), sh) * nrm;
    for (int k = 0; k < 2; k++) {
      vec3 dl = u_lampPos[k] - center;
      float d2 = dot(dl, dl);
      L = dl * inversesqrt(d2);
      s += u_lampCol[k] / (d2 + 0.04) * max(dot(N, L), 0.0) * pow(max(dot(N, normalize(L + Vd)), 0.0), sh) * nrm;
    }
    // The window is a huge, bright source: a broad lobe weighted by how much sky this splat sees.
    L = normalize(u_winPos - center);
    float shw = max(sh * 0.12, 3.0);
    s += u_winCol * skyVis * max(dot(N, L), 0.0) * pow(max(dot(N, normalize(L + Vd)), 0.0), shw) * (shw + 8.0) / (8.0 * PI);
    col += m.x * F * min(s, vec3(40.0));
  }

  float rev = clamp((u_reveal - length(center - u_revealOrigin)) / 1.2, 0.0, 1.0);
  v_color = vec4(col, enc.a * rev);
  v_pos = a_quad;
  vec2 ndc = clip.xy / clip.w;
  gl_Position = vec4(ndc + (a_quad.x * major + a_quad.y * minor) * (2.0 * rev) / u_viewport, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_pos;
out vec4 fragColor;
void main() {
  float A = -dot(v_pos, v_pos);
  if (A < -4.0) discard;
  float alpha = exp(A) * v_color.a;
  fragColor = vec4(v_color.rgb * alpha, alpha);
}`;

const FULL_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform float u_exposure;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 px = 1.0 / vec2(textureSize(u_src, 0));
  vec3 c = vec3(0.0);
  for (int y = -1; y <= 1; y += 2) for (int x = -1; x <= 1; x += 2) c += texture(u_src, v_uv + vec2(x, y) * px).rgb;
  c *= 0.25 * u_exposure;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * max(l - 0.9, 0.0) / max(l, 1e-4), 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 px = u_dir / vec2(textureSize(u_src, 0));
  const float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
  vec3 c = texture(u_src, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture(u_src, v_uv + px * float(i)).rgb * w[i];
    c += texture(u_src, v_uv - px * float(i)).rgb * w[i];
  }
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_scene, u_bloom;
uniform float u_exposure, u_time;
uniform vec3 u_bg;
in vec2 v_uv;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 s = texture(u_scene, v_uv);
  vec3 c = s.rgb + u_bg * (1.0 - s.a);
  c = c * u_exposure + texture(u_bloom, v_uv).rgb * 0.45;
  c *= vec3(1.03, 1.0, 0.96);                       // a touch of warmth
  c = aces(c);
  vec2 q = v_uv - 0.5;
  c *= 1.0 - 0.32 * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(gl_FragCoord.xy + fract(u_time) * 97.0) - 0.5) * (3.0 / 255.0);
  o = vec4(c, 1.0);
}`;

const PER_ROW = 1024;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export class SplatRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    this.splat = program(gl, SPLAT_VS, SPLAT_FS);
    this.bright = program(gl, FULL_VS, BRIGHT_FS);
    this.blur = program(gl, FULL_VS, BLUR_FS);
    this.comp = program(gl, FULL_VS, COMPOSITE_FS);
    this.emptyVao = gl.createVertexArray();

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]), gl.STATIC_DRAW);
    const aQuad = gl.getAttribLocation(this.splat.p, 'a_quad');
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    const aIndex = gl.getAttribLocation(this.splat.p, 'a_index');
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribIPointer(aIndex, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(aIndex, 1);
    gl.bindVertexArray(null);

    this.texture = gl.createTexture();
    this.count = 0;
    this.targets = null;
    this.exposure = 1.0;
    this.background = [0.012, 0.008, 0.006];
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  ensureTargets() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    if (this.targets) for (const t of [this.targets.scene, this.targets.a, this.targets.b]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.targets = { w, h, scene: this.makeTarget(w, h), a: this.makeTarget(qw, qh), b: this.makeTarget(qw, qh) };
  }

  load({ positions, covariances, colors, normals, extra, count }) {
    const gl = this.gl;
    const texW = PER_ROW * 3, texH = Math.ceil(count / PER_ROW);
    const u32 = new Uint32Array(texW * texH * 4);
    const f32 = new Float32Array(u32.buffer);
    for (let i = 0; i < count; i++) {
      const o = ((i >> 10) * texW + (i & 1023) * 3) * 4;
      f32[o] = positions[i * 3];
      f32[o + 1] = positions[i * 3 + 1];
      f32[o + 2] = positions[i * 3 + 2];
      u32[o + 3] = (colors[i * 4] | (colors[i * 4 + 1] << 8) | (colors[i * 4 + 2] << 16) | (colors[i * 4 + 3] << 24)) >>> 0;
      const c = i * 6;
      f32[o + 4] = covariances[c];
      f32[o + 5] = covariances[c + 1];
      f32[o + 6] = covariances[c + 2];
      f32[o + 7] = covariances[c + 3];
      f32[o + 8] = covariances[c + 4];
      f32[o + 9] = covariances[c + 5];
      u32[o + 10] = normals[i];
      u32[o + 11] = extra[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, texW, texH, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u32);
    this.count = count;
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    this.setOrder(order);
  }

  setLights(L) {
    this.lights = {
      sunDir: L.sunDir,
      sunCol: L.sunColor.map((c) => c * L.sunE),
      lampPos: L.lamps.flatMap((l) => l.p),
      lampCol: L.lamps.flatMap((l) => l.c.map((c) => c * l.i)),
      winPos: L.window.p,
      winCol: L.window.c.map((c) => c * 7),
    };
  }

  setOrder(order) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
  }

  draw({ view, proj, eye, reveal, revealOrigin, time }) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    this.ensureTargets();
    const T = this.targets;

    // 1. Splats → HDR scene buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count) {
      const { p, u } = this.splat;
      gl.useProgram(p);
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(u.u_data, 0);
      gl.uniformMatrix4fv(u.u_view, false, view);
      gl.uniformMatrix4fv(u.u_proj, false, proj);
      gl.uniform2f(u.u_focal, proj[0] * w * 0.5, proj[5] * h * 0.5);
      gl.uniform2f(u.u_viewport, w, h);
      gl.uniform3fv(u.u_revealOrigin, revealOrigin);
      gl.uniform1f(u.u_reveal, reveal);
      gl.uniform3fv(u.u_eye, eye);
      const L = this.lights;
      gl.uniform3fv(u.u_sunDir, L.sunDir);
      gl.uniform3fv(u.u_sunCol, L.sunCol);
      gl.uniform3fv(u.u_lampPos, L.lampPos);
      gl.uniform3fv(u.u_lampCol, L.lampCol);
      gl.uniform3fv(u.u_winPos, L.winPos);
      gl.uniform3fv(u.u_winCol, L.winCol);
      gl.uniform4fv(u.u_mat, MATERIALS.flatMap((m) => [m[0], m[1], m[2], 0]));
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.count);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    // 2. Bloom at quarter resolution.
    const pass = (prog, target, src, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.w : w, target ? target.h : h);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(prog.u.u_src ?? prog.u.u_scene, 0);
      setup?.(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(this.bright, T.a, T.scene.tex, (u) => gl.uniform1f(u.u_exposure, this.exposure));
    for (const r of [1, 2.5]) {
      pass(this.blur, T.b, T.a.tex, (u) => gl.uniform2f(u.u_dir, r, 0));
      pass(this.blur, T.a, T.b.tex, (u) => gl.uniform2f(u.u_dir, 0, r));
    }

    // 3. Tone map to the canvas.
    pass(this.comp, null, T.scene.tex, (u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, T.a.tex);
      gl.uniform1i(u.u_bloom, 1);
      gl.uniform1f(u.u_exposure, this.exposure);
      gl.uniform1f(u.u_time, time);
      gl.uniform3fv(u.u_bg, this.background);
    });
  }
}
