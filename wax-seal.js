/* Wax Seal — vanilla WebGL port.
 *
 * Ported from Originkit's "Wax Seal" component (React + three.js).
 * The height-field bake, the SDF morph and the gold shading are the original's
 * maths; three.js is replaced by one raw WebGL2 quad (the original camera is
 * orthographic and looks straight down, so vertex displacement never moves a
 * pixel on screen), and the emblem is drawn from text instead of an image.
 *
 * Usage: WaxSeal.mount(hostEl, { text, color, duration, cssSize, reduced })
 *        → Promise<api|null>   api: { snapshot(), destroy() }
 */
(function () {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const map = (v, lo, hi, span = 20) => lo + (clamp(v, 0, span) / span) * (hi - lo);
  function smoothstepJS(e0, e1, x) { const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function smootherstepJS(e0, e1, x) { const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1); return t * t * t * (t * (6 * t - 15) + 10); }
  function crestProfile(edgeToCenter, shape) {
    const q = clamp(edgeToCenter, 0, 1);
    const sharp = q, bubble = Math.sqrt(Math.max(0, 1 - Math.pow(1 - q, 2))), flat = smootherstepJS(0, 0.62, q);
    const s = clamp(shape, 0, 2);
    return s <= 1 ? sharp + (bubble - sharp) * s : bubble + (flat - bubble) * (s - 1);
  }
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function edgeRadius(angle, irregularity, lobes, seed) {
    const irr = clamp(irregularity, 0, 0.75), n = Math.max(3, Math.min(12, Math.round(lobes)));
    const a = angle + seed * 0.35;
    const lobe = Math.sin(a * n) * 0.6 + Math.sin(a * (n + 1) + 1.3) * 0.2;
    return 1 + lobe * irr * 0.45;
  }

  function boxBlur(data, size, radius, passes) {
    if (radius < 1) return;
    const line = new Float32Array(size), w = radius * 2 + 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < size; y++) {
        const row = y * size;
        for (let x = 0; x < size; x++) line[x] = data[row + x];
        let acc = 0;
        for (let x = -radius; x <= radius; x++) acc += line[clamp(x, 0, size - 1)];
        for (let x = 0; x < size; x++) {
          data[row + x] = acc / w;
          acc += line[Math.min(size - 1, x + radius + 1)] - line[Math.max(0, x - radius)];
        }
      }
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) line[y] = data[y * size + x];
        let acc = 0;
        for (let y = -radius; y <= radius; y++) acc += line[clamp(y, 0, size - 1)];
        for (let y = 0; y < size; y++) {
          data[y * size + x] = acc / w;
          acc += line[Math.min(size - 1, y + radius + 1)] - line[Math.max(0, y - radius)];
        }
      }
    }
  }

  function chamferDistance(mask, size, region) {
    const dist = new Float32Array(size * size), far = size * 2, dg = Math.SQRT2;
    for (let i = 0; i < dist.length; i++) dist[i] = mask[i] === region ? far : 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x; if (dist[i] === 0) continue; let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) d = Math.min(d, dist[i - size] + 1);
      if (x > 0 && y > 0) d = Math.min(d, dist[i - size - 1] + dg);
      if (x + 1 < size && y > 0) d = Math.min(d, dist[i - size + 1] + dg);
      dist[i] = d;
    }
    for (let y = size - 1; y >= 0; y--) for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x; if (dist[i] === 0) continue; let d = dist[i];
      if (x + 1 < size) d = Math.min(d, dist[i + 1] + 1);
      if (y + 1 < size) d = Math.min(d, dist[i + size] + 1);
      if (x + 1 < size && y + 1 < size) d = Math.min(d, dist[i + size + 1] + dg);
      if (x > 0 && y + 1 < size) d = Math.min(d, dist[i + size - 1] + dg);
      dist[i] = d;
    }
    return dist;
  }

  const LOGO_RISE_CAP = 0.03;

  /* R = outer wax height, G = stamp delta (0.5 = none), B = well-floor mask, A = silhouette SDF */
  function buildSealTexture(o) {
    const size = o.size;
    const logoCanvas = document.createElement('canvas'); logoCanvas.width = logoCanvas.height = size;
    const lctx = logoCanvas.getContext('2d', { willReadFrequently: true });
    const ls = clamp(o.logoSize, 5, 120) / 48;
    // Emblem: a tightly cropped text canvas, scaled to fit, alpha is the mask.
    const img = o.logoImg, maxDim = size * 0.4 * ls;
    const scale = maxDim / Math.max(img.width, img.height);
    const dw = Math.max(1, Math.round(img.width * scale)), dh = Math.max(1, Math.round(img.height * scale));
    lctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);

    const logoPixels = lctx.getImageData(0, 0, size, size).data;
    const logoMask = new Uint8Array(size * size);
    for (let p = 0; p < logoMask.length; p++) logoMask[p] = logoPixels[p * 4 + 3] >= 128 ? 1 : 0;
    const logoInside = chamferDistance(logoMask, size, 1), logoOutside = chamferDistance(logoMask, size, 0);
    let logoRadius = 1;
    for (let p = 0; p < logoInside.length; p++) logoRadius = Math.max(logoRadius, logoInside[p]);
    const logoWeightPx = size * clamp(o.logoWeight, -1, 4) * 0.006;
    const logoCoreRadius = Math.max(1, logoRadius + logoWeightPx);
    const logoBevelPx = size * clamp(o.logoBevel, 0, 2) * 0.012;
    const logoRiseRadius = Math.min(logoCoreRadius, size * LOGO_RISE_CAP);

    const data = new Float32Array(size * size * 4);
    const edgeHeight = new Float32Array(size * size), stampHeight = new Float32Array(size * size);
    const ringHeight = new Float32Array(size * size), logoHeight = new Float32Array(size * size);

    const rimW = clamp(o.rimWidth, 3, 50) / 100, wellR = clamp(o.ringSize, 15, 85) / 100;
    const nRings = o.showRings ? Math.max(0, Math.min(8, Math.round(o.ringCount))) : 0;
    const spacing = clamp(o.ringSpacing, 0, 30) / 100;
    const slope = 0.003 + clamp(o.ringBevel, 0, 2) * 0.027;
    const ridgeRadius = 0.004 + clamp(o.ringWidth, 0, 2) * 0.01 + clamp(o.ringPeak, 0, 2) * 0.008 + slope;
    const rHeight = 0.025 + clamp(o.ringRelief, 0, 3) * 0.12;
    const logoH = ((logoRiseRadius / size) * 2.2 * clamp(o.logoRelief, 0, 3)) / (0.34 * clamp(o.relief, 0.1, 3));
    const wellD = 0.035 + clamp(o.wellDepth, 0, 3) * 0.1;
    const edgeRound = clamp(o.edgeRoundness, 0, 2), ringRound = clamp(o.ringRoundness, 0, 2), logoRound = clamp(o.logoRoundness, 0, 2);
    const ridgeProfile = dist => crestProfile(1 - dist / Math.max(1e-6, ridgeRadius), o.ringCrest);

    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const pi = (size - 1 - y) * size + x, i = pi * 4;
      const nx = (x / (size - 1)) * 2 - 1, ny = (y / (size - 1)) * 2 - 1;
      const r = Math.hypot(nx, ny), angle = Math.atan2(ny, nx);
      const d = 0.84 * edgeRadius(angle, o.irregularity, o.lobes, o.shapeSeed) - r;
      const sd = clamp(0.5 + d * 0.55, 0, 1);

      const body = 0.48 * smootherstepJS(0, rimW * (0.2 + edgeRound * 0.08), d);
      const rimCenter = rimW * (0.46 + edgeRound * 0.05), rimHalf = rimW * (0.5 + edgeRound * 0.3);
      const rimT = clamp(Math.abs(d - rimCenter) / Math.max(1e-6, rimHalf), 0, 1);
      const outer = body + 0.28 * crestProfile(1 - rimT, o.edgeCrest);

      const stampR = wellR + 0.065, stampBevel = 0.024 + ringRound * 0.012;
      const stamped = 1 - smootherstepJS(stampR - stampBevel, stampR + stampBevel, r);
      const pinch = Math.pow(1 - smootherstepJS(0, 0.035 + stampBevel, Math.abs(r - stampR)), 2);
      const stampDelta = -wellD * stamped - wellD * 0.22 * pinch;

      for (let k = 0; k < nRings; k++) {
        const rr = wellR - k * spacing; if (rr < 0.08) continue;
        const center = k === 0 ? wellR + 0.004 : rr, amp = rHeight * (k === 0 ? 1.15 : 1 - k * 0.08);
        ringHeight[pi] += amp * ridgeProfile(Math.abs(r - center));
      }
      if (r < wellR - 0.04) {
        const lp = y * size + x;
        const signedDistance = (logoMask[lp] ? logoInside[lp] : -logoOutside[lp]) + logoWeightPx;
        logoHeight[pi] = crestProfile((signedDistance + logoBevelPx) / (logoRiseRadius + logoBevelPx), o.logoCrest) * logoH;
      }
      edgeHeight[pi] = outer; stampHeight[pi] = stampDelta;
      data[i + 2] = clamp(stamped, 0, 1); data[i + 3] = sd;
    }
    const bs = size / 768; // blur radii were authored for a 768 texture
    boxBlur(edgeHeight, size, Math.round(edgeRound * 12 * bs), 3);
    boxBlur(ringHeight, size, Math.round(ringRound * 9 * bs), 3);
    boxBlur(logoHeight, size, Math.round(logoRound * 9 * bs), 3);
    for (let p = 0; p < size * size; p++) {
      const i = p * 4;
      data[i] = clamp(edgeHeight[p], 0, 1);
      data[i + 1] = clamp(0.5 + (stampHeight[p] + ringHeight[p] + logoHeight[p]) * 0.5, 0, 1);
    }
    return data;
  }

  const SHARED_GLSL = `
    precision highp float;
    uniform sampler2D uMap;
    uniform float uSpread, uLobe, uStamp, uRadius;
    float ballDome(float r){ float x=clamp(r/max(uRadius,1e-4),0.0,1.0); return sqrt(max(0.0,1.0-x*x))*mix(1.55,0.66,uSpread); }
    float edgeDist(vec2 uv){ vec2 p=uv*2.0-1.0; float dBall=uRadius-length(p); float dFinal=(texture2D(uMap,uv).a-0.5)/0.55; return mix(dBall,dFinal,uLobe); }
    float compositeH(vec2 uv){
      vec2 p=uv*2.0-1.0; float r=length(p); vec4 t=texture2D(uMap,uv);
      float h=mix(ballDome(r),t.r,uSpread);
      h+=(t.g-0.5)*2.0*uStamp*smoothstep(0.0,0.033,t.a-0.5);
      h*=smoothstep(-0.015,0.05,edgeDist(uv)); return h; }
    float compositeA(vec2 uv){ return smoothstep(-0.012,0.012,edgeDist(uv)); }`;
  const VERT = `attribute vec2 aPos; uniform float uScale; varying vec2 vUv;
    void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos*uScale,0.0,1.0); }`;
  const FRAG = SHARED_GLSL + `
    uniform vec3 uColor; uniform float uDisp, uFade, uTexel; uniform vec3 uLight; varying vec2 vUv;
    const float GLOSS=2.0; const float SPECULAR=1.2; const float GOLD_DEPTH=1.0; const float WARMTH=0.0; const float SHEEN=1.05;
    const float FILL_LIGHT=1.05; const float LIGHT_SIZE=3.0; const float EDGE_FOCUS=0.7; const float CONTRAST=2.5; const float AO=1.2;
    float specularLobe(vec3 n, vec3 v, vec3 l, float tp, float bp){
      float ndh=max(dot(n,normalize(l+v)),0.0);
      return pow(ndh,tp)*(tp+2.0)/60.0*1.15 + pow(ndh,bp)*(bp+2.0)/17.0*0.18*SHEEN; }
    void main(){
      float alpha=compositeA(vUv)*uFade; if(alpha<0.01) discard;
      float e=uTexel*1.6; float hC=compositeH(vUv);
      float hR=compositeH(vUv+vec2(e,0.0)), hL=compositeH(vUv-vec2(e,0.0)), hU=compositeH(vUv+vec2(0.0,e)), hD=compositeH(vUv-vec2(0.0,e));
      float k=uDisp/2.2/(2.0*e)*CONTRAST;
      vec3 n=normalize(vec3(-(hR-hL)*k,-(hU-hD)*k,1.0));
      float e2=uTexel*7.0; float occ=0.0;
      occ+=max(0.0,compositeH(vUv+vec2(e2,0.0))-hC); occ+=max(0.0,compositeH(vUv-vec2(e2,0.0))-hC);
      occ+=max(0.0,compositeH(vUv+vec2(0.0,e2))-hC); occ+=max(0.0,compositeH(vUv-vec2(0.0,e2))-hC);
      float ao=1.0-clamp(occ*AO,0.0,0.4);
      vec3 L=normalize(uLight); vec3 V=vec3(0.0,0.0,1.0);
      float lit=dot(n,L)*0.5+0.5;
      float fill=max(dot(n,normalize(vec3(-uLight.x,-uLight.y,0.35))),0.0);
      vec3 deepGold=mix(uColor*0.26,vec3(0.28,0.16,0.02),0.55);
      vec3 deep=mix(uColor*0.58,deepGold,min(GOLD_DEPTH,1.0)); deep*=1.0-max(GOLD_DEPTH-1.0,0.0)*0.22;
      vec3 mid=uColor;
      vec3 hi=mix(mix(uColor,vec3(1.0,0.98,0.9),0.85),mix(uColor*1.15,vec3(1.0,0.78,0.3),0.42),WARMTH);
      vec3 base=mix(deep,mid,smoothstep(0.42,0.8,lit)); base=mix(base,hi,smoothstep(0.88,1.0,lit));
      base+=mid*fill*0.28*FILL_LIGHT;
      float slope=length(n.xy);
      float perimeter=1.0-smoothstep(0.07,0.27,edgeDist(vUv));
      float reliefOnly=smoothstep(0.025,0.22,slope);
      float focusMask=mix(1.0,perimeter*1.25+reliefOnly*0.12,EDGE_FOCUS);
      float tp=10.0+GLOSS*70.0, bp=3.0+GLOSS*14.0;
      vec3 lt=normalize(vec3(-L.y,L.x,0.0)); vec3 lb=normalize(cross(L,lt)); float sp=LIGHT_SIZE*0.36;
      float a=specularLobe(n,V,L,tp,bp);
      a+=specularLobe(n,V,normalize(L+lt*sp),tp,bp); a+=specularLobe(n,V,normalize(L-lt*sp),tp,bp);
      a+=specularLobe(n,V,normalize(L+lb*sp),tp,bp); a+=specularLobe(n,V,normalize(L-lb*sp),tp,bp);
      float spec=a*0.2*(1.0/(1.0+LIGHT_SIZE*0.3))*SPECULAR*focusMask;
      vec3 col=base+spec*mix(vec3(1.0,0.97,0.88),mix(vec3(1.0,0.82,0.42),uColor*1.22,0.35),WARMTH);
      col*=ao;
      gl_FragColor=vec4(col*alpha,alpha);
    }`;

  function emblemCanvas(text) {
    const font = '700 220px "Noto Serif KR", Georgia, "Times New Roman", serif';
    const m = document.createElement('canvas').getContext('2d'); m.font = font;
    const mt = m.measureText(text);
    const asc = Math.ceil(mt.actualBoundingBoxAscent || 170), desc = Math.ceil(mt.actualBoundingBoxDescent || 20);
    const left = Math.ceil(mt.actualBoundingBoxLeft || 0), right = Math.ceil(mt.actualBoundingBoxRight || mt.width);
    const c = document.createElement('canvas'); c.width = left + right + 8; c.height = asc + desc + 8;
    const ctx = c.getContext('2d'); ctx.font = font; ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, left + 4, asc + 4);
    return c;
  }

  function hexRgb(hex) { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

  async function mount(host, opt) {
    opt = Object.assign({ text: 'S♥J', color: '#E9BE4E', duration: 1.5, cssSize: 132, textureSize: 512, reduced: false }, opt || {});
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return null;
    try {
      if (document.fonts && document.fonts.load)
        await Promise.race([document.fonts.load('700 100px "Noto Serif KR"', opt.text), new Promise(r => setTimeout(r, 1200))]);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 30)); // let the page paint before the bake

    const size = opt.textureSize;
    const data = buildSealTexture({
      size, logoImg: emblemCanvas(opt.text),
      relief: 0.45, irregularity: map(5, 0, 0.75), lobes: 8, shapeSeed: 0, rimWidth: 19,
      edgeCrest: 1, edgeRoundness: 0.9, wellDepth: map(10, 0, 3),
      logoSize: 58, logoWeight: map(12, -1, 4), logoRelief: 0.6, logoBevel: 0.1, logoCrest: 1, logoRoundness: 0.4,
      showRings: true, ringCount: 1, ringSize: 62, ringSpacing: 6,
      ringRelief: 0.6, ringWidth: 1, ringPeak: 1, ringBevel: 0.2, ringCrest: 1, ringRoundness: 0.3,
    });

    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    let prog, tex, buf;
    try {
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, size, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('texture');
    } catch (e) { console.warn('[wax-seal] fallback:', e.message); return null; }

    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(opt.cssSize * dpr);
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = n => gl.getUniformLocation(prog, n);
    const u = { scale: U('uScale'), spread: U('uSpread'), lobe: U('uLobe'), stamp: U('uStamp'), radius: U('uRadius'), fade: U('uFade'), light: U('uLight') };
    gl.uniform1i(U('uMap'), 0); gl.uniform1f(U('uDisp'), 0.34 * 0.45); gl.uniform1f(U('uTexel'), 1 / size);
    gl.uniform3fv(U('uColor'), hexRgb(opt.color));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);

    const BASE = 1.1 / 1.18; // plane 2.2 inside an orthographic view of ±1.18
    const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    function pose(p) {
      const pe = ease(p), fade = smoothstepJS(0, 0.05, pe);
      const pour = smoothstepJS(0, 0.48, pe), pourEase = easeOutCubic(pour);
      const jiggle = Math.sin(pour * Math.PI * 3) * (1 - pour) * (1 - pour) * 0.035;
      const blobRadius = 0.12 + 0.34 * pourEase + jiggle;
      const press = smoothstepJS(0.52, 0.72, pe), pressEase = easeOutCubic(press);
      const lobeTime = clamp((pe - 0.52) / 0.48, 0, 1);
      gl.uniform1f(u.fade, fade);
      gl.uniform1f(u.spread, 0.12 * pour + 0.88 * easeInOutCubic(press));
      gl.uniform1f(u.radius, blobRadius + (0.72 - blobRadius) * pressEase);
      gl.uniform1f(u.lobe, 1 - Math.pow(1 - lobeTime, 1.45));
      gl.uniform1f(u.stamp, easeOutBack(press));
      gl.uniform1f(u.scale, BASE * (1 + Math.sin(press * Math.PI) * 0.045));
    }

    let raf = 0, dead = false, progress = opt.reduced ? 1 : 0, cursor = null, lx = 0, ly = 0;
    const t0 = performance.now(), elev = 21 * Math.PI / 180;
    const onMove = e => { cursor = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointermove', onMove, { passive: true });
    function draw(now) {
      // Key light: follows the pointer on desktop; on touch it sways slowly so the gold keeps glinting.
      let ang = (139 + (opt.reduced ? 0 : Math.sin((now - t0) / 1400) * 32)) * Math.PI / 180;
      let tx = Math.cos(ang), ty = Math.sin(ang);
      if (cursor) {
        const r = canvas.getBoundingClientRect(), dx = cursor.x - (r.left + r.width / 2), dy = cursor.y - (r.top + r.height / 2), len = Math.hypot(dx, dy);
        if (len > 1) { tx = dx / len; ty = -dy / len; }
      }
      if (lx === 0 && ly === 0) { lx = tx; ly = ty; } else { lx += (tx - lx) * 0.12; ly += (ty - ly) * 0.12; }
      const rad = Math.atan2(ly, lx), pl = Math.cos(elev);
      gl.uniform3f(u.light, Math.cos(rad) * pl, Math.sin(rad) * pl, Math.sin(elev));
      if (progress < 1) progress = clamp((now - t0) / (opt.duration * 1000), 0, 1);
      pose(progress);
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function loop(now) { if (dead) return; draw(now); raf = opt.reduced && progress >= 1 && !cursor ? 0 : requestAnimationFrame(loop); }
    raf = requestAnimationFrame(loop);

    return {
      canvas,
      snapshot() { draw(performance.now()); return canvas.toDataURL('image/png'); },
      destroy() {
        if (dead) return; dead = true; cancelAnimationFrame(raf); window.removeEventListener('pointermove', onMove);
        canvas.remove(); gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog);
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      },
    };
  }

  window.WaxSeal = { mount };
})();
