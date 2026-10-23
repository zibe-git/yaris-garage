// WebGL2 plumbing: context + canvas sizing with an adaptive pixel ratio, shader programs with cached uniform
// setters, buffers / textures / framebuffers, and a frame loop that sleeps while the page is hidden.

/** GLSL header shared by every shader. */
export const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

export function createGL(canvas, { alpha = false, antialias = true, maxDpr = 2 } = {}) {
  const gl = canvas.getContext('webgl2', { alpha, antialias, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is not available on this device');
  gl.getExtension('EXT_color_buffer_float');
  const ctx = {
    gl,
    canvas,
    width: 1,
    height: 1,
    // Adaptive resolution: the loop lowers dprScale when frames are slow and raises it again when there is headroom.
    dprScale: 1,
    maxDpr,
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, ctx.maxDpr) * ctx.dprScale;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w !== canvas.width || h !== canvas.height) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.width = w;
      ctx.height = h;
      return ctx;
    },
    get aspect() {
      return ctx.width / ctx.height;
    },
    /** Free the GPU memory at once (mobile browsers cap the number of live contexts). */
    destroy() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
  return ctx.resize();
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n');
    throw new Error(`shader compile failed: ${log}\n${lines}`);
  }
  return s;
}

/**
 * Link a program. `u` maps uniform names to setters picked from the active uniform type, so callers write
 * prog.set({ uView: m, uColor: [1, 0, 0] }) without caring about uniform3fv vs uniformMatrix4fv.
 */
export function program(gl, vs, fs, attribs = {}) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, HEADER + vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, HEADER + fs));
  for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  const setters = {};
  let unit = 0;
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(p, info.name);
    const T = gl;
    switch (info.type) {
      case T.FLOAT: setters[name] = (v) => (info.size > 1 ? gl.uniform1fv(loc, v) : gl.uniform1f(loc, v)); break;
      case T.FLOAT_VEC2: setters[name] = (v) => gl.uniform2fv(loc, v); break;
      case T.FLOAT_VEC3: setters[name] = (v) => gl.uniform3fv(loc, v); break;
      case T.FLOAT_VEC4: setters[name] = (v) => gl.uniform4fv(loc, v); break;
      case T.INT: case T.BOOL: setters[name] = (v) => gl.uniform1i(loc, v); break;
      case T.INT_VEC2: setters[name] = (v) => gl.uniform2iv(loc, v); break;
      case T.FLOAT_MAT3: setters[name] = (v) => gl.uniformMatrix3fv(loc, false, v); break;
      case T.FLOAT_MAT4: setters[name] = (v) => gl.uniformMatrix4fv(loc, false, v); break;
      case T.SAMPLER_2D: case T.SAMPLER_3D: case T.INT_SAMPLER_2D: case T.UNSIGNED_INT_SAMPLER_2D: {
        const u = unit++;
        const target = info.type === T.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D;
        setters[name] = (tex) => {
          gl.activeTexture(gl.TEXTURE0 + u);
          gl.bindTexture(target, tex);
          gl.uniform1i(loc, u);
        };
        break;
      }
      default: setters[name] = () => {};
    }
  }
  return {
    program: p,
    use() {
      gl.useProgram(p);
      return this;
    },
    set(values) {
      for (const k in values) setters[k]?.(values[k]);
      return this;
    },
    has: (name) => name in setters,
  };
}

export function buffer(gl, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

/**
 * Vertex array from a list of attributes:
 * { loc, buffer, size, type = FLOAT, normalized = false, stride = 0, offset = 0, divisor = 0, integer = false }
 */
export function vao(gl, attributes, indexBuffer) {
  const v = gl.createVertexArray();
  gl.bindVertexArray(v);
  for (const a of attributes) {
    gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
    gl.enableVertexAttribArray(a.loc);
    if (a.integer) gl.vertexAttribIPointer(a.loc, a.size, a.type, a.stride || 0, a.offset || 0);
    else gl.vertexAttribPointer(a.loc, a.size, a.type ?? gl.FLOAT, !!a.normalized, a.stride || 0, a.offset || 0);
    if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
  }
  if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bindVertexArray(null);
  return v;
}

/** 2D texture. data may be null (render target), a typed array, or an image / canvas. */
export function texture(gl, { width, height, data = null, internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, mipmap = false }) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  if (data && !ArrayBuffer.isView(data)) gl.texImage2D(gl.TEXTURE_2D, 0, internal, format, type, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

/** Framebuffer with one colour texture and a depth renderbuffer; resize(w, h) reallocates. */
export function framebuffer(gl, { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, filter = gl.NEAREST, depth = true } = {}) {
  const fb = { fbo: gl.createFramebuffer(), tex: null, depth: depth ? gl.createRenderbuffer() : null, width: 0, height: 0 };
  fb.resize = (w, h) => {
    if (w === fb.width && h === fb.height) return fb;
    fb.width = w;
    fb.height = h;
    if (fb.tex) gl.deleteTexture(fb.tex);
    fb.tex = texture(gl, { width: w, height: h, internal, format, type, filter });
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fb.tex, 0);
    if (fb.depth) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, fb.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fb.depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  };
  return fb;
}

/**
 * requestAnimationFrame loop with dt in seconds (clamped), paused while the tab is hidden, and an adaptive pixel
 * ratio: if the average frame time stays above ~20 ms the drawing buffer shrinks, below ~14 ms it grows back.
 */
export function loop(ctx, frame, { adaptive = true, minScale = 0.5 } = {}) {
  let raf = 0;
  let last = 0;
  let running = true;
  let avg = 16;
  let cooldown = 0;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    if (adaptive) {
      avg += (dt * 1000 - avg) * 0.05;
      if ((cooldown -= dt) <= 0) {
        if (avg > 21 && ctx.dprScale > minScale) {
          ctx.dprScale = Math.max(minScale, ctx.dprScale - 0.1);
          cooldown = 1;
        } else if (avg < 14 && ctx.dprScale < 1) {
          ctx.dprScale = Math.min(1, ctx.dprScale + 0.05);
          cooldown = 2;
        }
      }
    }
    ctx.resize();
    frame(dt, now / 1000);
  };
  const onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (running && !raf) {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

/** Fullscreen triangle vertex shader (no buffers needed: gl.drawArrays(gl.TRIANGLES, 0, 3)). */
export const FULLSCREEN_VS = `
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
