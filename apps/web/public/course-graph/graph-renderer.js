// User-supplied graph reimplementation, adapted for Studio; original comments retained.
/**
 * graph-renderer.js — WebGL2 图谱渲染器（重写版 v2）
 *
 * 对应原版方案：原版把 PixiJS（WebGL）跑在隔离 iframe 里；本重写直接用原生
 * WebGL2 实例化实现同样的绘制语义，零依赖：
 *
 *  - 连线：每条边一个世界坐标系下的四边形实例，fragment 内沿法线做抗锯齿；
 *    厚度有 1 设备像素下限（缩放后不会消失、不发抖）
 *  - 节点：实例化四边形 + 片元 SDF 圆；四边形外扩 0.8px 作为 AA 缓冲，
 *    极小尺寸下也不会退化成方块
 *  - 高亮环：SDF 圆环，内外边界各自抗锯齿
 *  - 箭头：实例化三角形 SDF
 *  - 文字标签：独立 2D canvas 叠加层，字号由调用方按「屏幕像素」给定
 *    （缩放策略在 GraphView 内决定），水平居中、位于节点下方
 *
 * 所有实例的几何量（halfW/halfH）语义统一为「半宽/半高（世界单位）」，
 * 边界比例通过 data1.yz 逐实例传入，避免 uniform 无法分批的问题。
 */

"use strict";

const GRAPH_SHADERS = {
  quadVert: `#version 300 es
    layout(location=0) in vec2 a_corner;      // 单位四边形角点 [-1,1]
    layout(location=1) in vec4 a_data0;       // center.xy, halfW, halfH (世界)
    layout(location=2) in vec4 a_data1;       // angle, edgeA, edgeB, unused
    layout(location=3) in vec4 a_color;       // rgba

    uniform vec4 u_view;                      // scale, panX, panY, dpr
    uniform vec2 u_viewport;                  // canvas 尺寸（设备像素）

    out vec2 v_uv;
    out vec4 v_color;
    out vec2 v_edge;
    out vec2 v_half;

    void main() {
      // 先按 (halfW, halfH) 缩放单位四边形，再旋转（顺序不可交换！）
      vec2 scaled = a_corner * a_data0.zw;
      float c = cos(a_data1.x), s = sin(a_data1.x);
      vec2 local = vec2(scaled.x * c - scaled.y * s,
                        scaled.x * s + scaled.y * c);
      vec2 world = a_data0.xy + local;
      vec2 screen = world * u_view.x + u_view.yz;
      vec2 clip = (screen / (u_viewport * 0.5)) - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_uv = a_corner;
      v_color = a_color;
      v_edge = a_data1.yz;
      v_half = a_data0.zw;
    }`,

  // 圆的 AA：把「到圆边的距离」换算成设备像素，用 0.5px 的覆盖度做 box filter。
  // 不依赖 fwidth —— fwidth 在极细几何上会随角度/位置跳变，正是“闪光”的来源。
  // 圆：2x2 子采样（4x 超采样）算覆盖率，比单点覆盖平滑 4 倍
  circleFrag: `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in vec4 v_color;
    in vec2 v_edge;
    in vec2 v_half;
    uniform vec4 u_view;
    out vec4 outColor;
    void main() {
      float halfW = max(v_half.x, 1e-6);
      float rWorld = v_edge.x * halfW;
      // 1 设备像素对应的 uv 偏移
      float pxUv = 1.0 / max(halfW * u_view.x, 1e-6);
      float acc = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 off = vec2(i == 0 || i == 3 ? -0.375 : 0.375,
                        i < 2 ? -0.375 : 0.375) * pxUv;
        float dPx = (length(v_uv + off) * halfW - rWorld) * u_view.x;
        acc += clamp(0.5 - dPx, 0.0, 1.0);
      }
      float alpha = acc * 0.25;
      if (alpha <= 0.002) discard;
      outColor = vec4(v_color.rgb, v_color.a * alpha);
    }`,

  // 连线 AA：到中心线的距离换算成设备像素，0.5px 覆盖度 → 恒定视觉宽度、无角度依赖、不闪
  // 线：沿法线做 4x 超采样。四边形的局部 y 轴始终垂直于线方向，
  // 所以对任意角度都能得到法线向 4 级覆盖率 —— 细线的亮度抖动下降约 4 倍。
  lineFrag: `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in vec4 v_color;
    in vec2 v_edge;
    in vec2 v_half;
    uniform vec4 u_view;
    out vec4 outColor;
    void main() {
      float halfH = max(v_half.y, 1e-6);
      float hWorld = v_edge.x * halfH;
      float pxUv = 1.0 / max(halfH * u_view.x, 1e-6);   // 1 设备像素的 uv 偏移
      float acc = 0.0;
      for (int i = 0; i < 4; i++) {
        float off = (i == 0 ? -0.375 : i == 1 ? -0.125 : i == 2 ? 0.125 : 0.375) * pxUv;
        float dPx = (abs(v_uv.y + off) * halfH - hWorld) * u_view.x;
        acc += clamp(0.5 - dPx, 0.0, 1.0);
      }
      float alpha = acc * 0.25;
      if (alpha <= 0.002) discard;
      outColor = vec4(v_color.rgb, v_color.a * alpha);
    }`,

  ringFrag: `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in vec4 v_color;
    in vec2 v_edge;
    in vec2 v_half;
    uniform vec4 u_view;
    out vec4 outColor;
    void main() {
      float halfW = max(v_half.x, 1e-6);
      float rInner = v_edge.x * halfW;
      float rOuter = v_edge.y * halfW;
      float pxUv = 1.0 / max(halfW * u_view.x, 1e-6);
      float acc = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 off = vec2(i == 0 || i == 3 ? -0.375 : 0.375,
                        i < 2 ? -0.375 : 0.375) * pxUv;
        float d = length(v_uv + off) * halfW;
        float dPx = max(rInner - d, d - rOuter) * u_view.x;
        acc += clamp(0.5 - dPx, 0.0, 1.0);
      }
      float alpha = acc * 0.25;
      if (alpha <= 0.002) discard;
      outColor = vec4(v_color.rgb, v_color.a * alpha);
    }`,

  arrowFrag: `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in vec4 v_color;
    in vec2 v_edge;
    in vec2 v_half;
    uniform vec4 u_view;
    out vec4 outColor;
    // 等腰三角形 SDF（指向 +x）：顶点 (1,0)，底 (-0.7, ±0.55)
    float sdTriangle(vec2 p) {
      vec2 a = vec2(1.0, 0.0), b = vec2(-0.7, 0.55), c = vec2(-0.7, -0.55);
      float d1 = dot(p - a, vec2(0.55, 0.55));
      float d2 = dot(p - b, vec2(-1.0, 0.0));
      float d3 = dot(p - c, vec2(0.55, -0.55));
      return max(d1, max(d2, d3));
    }
    void main() {
      float size = max(min(v_half.x, v_half.y), 1e-6);
      float dPx = sdTriangle(v_uv) * size * u_view.x;
      float alpha = clamp(0.5 - dPx, 0.0, 1.0);
      if (alpha <= 0.002) discard;
      outColor = vec4(v_color.rgb, v_color.a * alpha);
    }`,
};

class GraphGLRenderer {
  /**
   * @param {HTMLCanvasElement} glCanvas  WebGL 画布
   * @param {HTMLCanvasElement} labelCanvas 文字叠加画布
   */
  constructor(glCanvas, labelCanvas) {
    this.glCanvas = glCanvas;
    this.labelCanvas = labelCanvas;
    this.labelCtx = labelCanvas.getContext("2d");
    this.dpr = 1;
    this.width = 0;   // CSS 像素
    this.height = 0;

    const gl = glCanvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 不可用");
    this.gl = gl;

    this.progCircle = this._program(GRAPH_SHADERS.quadVert, GRAPH_SHADERS.circleFrag);
    this.progLine = this._program(GRAPH_SHADERS.quadVert, GRAPH_SHADERS.lineFrag);
    this.progRing = this._program(GRAPH_SHADERS.quadVert, GRAPH_SHADERS.ringFrag);
    this.progArrow = this._program(GRAPH_SHADERS.quadVert, GRAPH_SHADERS.arrowFrag);

    // 单位四边形索引缓冲（两三角）
    this.quadIndices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    // 单位角点（instanced attribute 0）
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

    this.instanceBufs = {
      data0: gl.createBuffer(),
      data1: gl.createBuffer(),
      color: gl.createBuffer(),
    };
    this.cpuArrays = {
      data0: new Float32Array(0),
      data1: new Float32Array(0),
      color: new Float32Array(0),
    };
    this.vao = gl.createVertexArray();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this._capacity = 0;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _program(vertSrc, fragSrc) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("program: " + gl.getProgramInfoLog(p));
    }
    return {
      program: p,
      u_view: gl.getUniformLocation(p, "u_view"),
      u_viewport: gl.getUniformLocation(p, "u_viewport"),
    };
  }

  resize(cssWidth, cssHeight, dpr) {
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    const w = Math.round(cssWidth * dpr), h = Math.round(cssHeight * dpr);
    if (this.glCanvas.width !== w) this.glCanvas.width = w;
    if (this.glCanvas.height !== h) this.glCanvas.height = h;
    if (this.labelCanvas.width !== w) this.labelCanvas.width = w;
    if (this.labelCanvas.height !== h) this.labelCanvas.height = h;
    this.glCanvas.style.width = cssWidth + "px";
    this.glCanvas.style.height = cssHeight + "px";
    this.labelCanvas.style.width = cssWidth + "px";
    this.labelCanvas.style.height = cssHeight + "px";
  }

  _ensureCapacity(count) {
    if (count <= this._capacity) return;
    const cap = Math.max(256, count * 2);
    this.cpuArrays.data0 = new Float32Array(cap * 4);
    this.cpuArrays.data1 = new Float32Array(cap * 4);
    this.cpuArrays.color = new Float32Array(cap * 4);
    this._capacity = cap;
  }

  /**
   * 绘制一帧
   * layers = {
   *   links:  {x1,y1,x2,y2,thickness, r,g,b,a}[],
   *   nodes:  {x,y,radius, r,g,b,a}[],
   *   rings:  {x,y,radius,width, r,g,b,a}[],
   *   arrows: {x,y,angle,size, r,g,b,a}[],
   *   labels: {x,y,text,screenFont,alpha,color}[],
   *   view:   {scale, panX, panY}
   * }
   */
  render(layers) {
    const gl = this.gl;
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const view = layers.view;
    const scale = view.scale;
    const px = 1 / scale;                  // 1 设备像素对应的世界长度
    const pad = 1.0 * px;                  // AA 缓冲（世界单位，覆盖 0.5px 羽化）

    const setView = (prog) => {
      gl.useProgram(prog.program);
      gl.uniform4f(prog.u_view, scale, view.panX, view.panY, this.dpr);
      gl.uniform2f(prog.u_viewport, this.glCanvas.width, this.glCanvas.height);
    };

    const bindInstanceAttribs = (count) => {
      const n = count * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBufs.data0);
      gl.bufferData(gl.ARRAY_BUFFER, this.cpuArrays.data0.subarray(0, n), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(1, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBufs.data1);
      gl.bufferData(gl.ARRAY_BUFFER, this.cpuArrays.data1.subarray(0, n), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(2, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBufs.color);
      gl.bufferData(gl.ARRAY_BUFFER, this.cpuArrays.color.subarray(0, n), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(3, 1);
    };

    const drawInstances = (prog, count) => {
      if (count <= 0) return;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIndices);
      setView(prog);
      bindInstanceAttribs(count);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
      gl.bindVertexArray(null);
    };

    // ---------------------------------------------------------------------
    // 1) 连线（AA + 1 设备像素最小厚度）
    // ---------------------------------------------------------------------
    const links = layers.links || [];
    {
      this._ensureCapacity(links.length);
      const data0 = this.cpuArrays.data0, data1 = this.cpuArrays.data1, color = this.cpuArrays.color;
      let i = 0;
      for (const L of links) {
        const dx = L.x2 - L.x1, dy = L.y2 - L.y1;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        // 目标线宽（设备像素）：
        //  · 基准 0.8 CSS 像素（≈ Obsidian 的细线观感），且不少于 1 设备像素
        //  · 缩小时再线性收细，避免“小节点配粗线”显得越缩越粗
        const zoomShrink = 0.8 + 0.2 * Math.min(1, scale);
        const minDevPx = Math.max(1.0, this.dpr * 0.8) * zoomShrink;
        const half = Math.max(L.thickness * zoomShrink, minDevPx * px) / 2;
        const cx = (L.x1 + L.x2) / 2, cy = (L.y1 + L.y2) / 2;
        const hw = len / 2 + pad, hh = half + pad;
        const o = i * 4;
        data0[o] = cx; data0[o + 1] = cy; data0[o + 2] = hw; data0[o + 3] = hh;
        data1[o] = Math.atan2(dy, dx);
        data1[o + 1] = half / hh;      // 真实半厚 / 四边形半高
        data1[o + 2] = 0; data1[o + 3] = 0;
        color[o] = L.r; color[o + 1] = L.g; color[o + 2] = L.b; color[o + 3] = L.a;
        i++;
      }
      drawInstances(this.progLine, i);
    }

    // ---------------------------------------------------------------------
    // 2) 节点圆
    // ---------------------------------------------------------------------
    const nodes = layers.nodes || [];
    {
      this._ensureCapacity(nodes.length);
      const data0 = this.cpuArrays.data0, data1 = this.cpuArrays.data1, color = this.cpuArrays.color;
      let i = 0;
      for (const N of nodes) {
        // 半径至少 0.6 设备像素，再外扩 AA 缓冲 → 极小尺寸也是圆而不是方块
        const r = Math.max(N.radius, 0.6 * px);
        const half = r + pad;
        const o = i * 4;
        data0[o] = N.x; data0[o + 1] = N.y; data0[o + 2] = half; data0[o + 3] = half;
        data1[o] = 0;
        data1[o + 1] = r / half;
        data1[o + 2] = 0; data1[o + 3] = 0;
        color[o] = N.r; color[o + 1] = N.g; color[o + 2] = N.b; color[o + 3] = N.a;
        i++;
      }
      drawInstances(this.progCircle, i);
    }

    // ---------------------------------------------------------------------
    // 3) 高亮环
    // ---------------------------------------------------------------------
    const rings = layers.rings || [];
    {
      this._ensureCapacity(rings.length);
      const data0 = this.cpuArrays.data0, data1 = this.cpuArrays.data1, color = this.cpuArrays.color;
      let i = 0;
      for (const R of rings) {
        const inner = Math.max(R.radius, 0.6 * px);
        const outer = inner + Math.max(R.width, 0.75 * px);
        const half = outer + pad;
        const o = i * 4;
        data0[o] = R.x; data0[o + 1] = R.y; data0[o + 2] = half; data0[o + 3] = half;
        data1[o] = 0;
        data1[o + 1] = inner / half;
        data1[o + 2] = outer / half;
        data1[o + 3] = 0;
        color[o] = R.r; color[o + 1] = R.g; color[o + 2] = R.b; color[o + 3] = R.a;
        i++;
      }
      drawInstances(this.progRing, i);
    }

    // ---------------------------------------------------------------------
    // 4) 箭头
    // ---------------------------------------------------------------------
    const arrows = layers.arrows || [];
    {
      this._ensureCapacity(arrows.length);
      const data0 = this.cpuArrays.data0, data1 = this.cpuArrays.data1, color = this.cpuArrays.color;
      let i = 0;
      for (const A of arrows) {
        const size = Math.max(A.size, 2 * px) * 1.15; // 少量外扩给 AA 留空间
        const o = i * 4;
        data0[o] = A.x; data0[o + 1] = A.y; data0[o + 2] = size; data0[o + 3] = size;
        data1[o] = A.angle; data1[o + 1] = 1; data1[o + 2] = 0; data1[o + 3] = 0;
        color[o] = A.r; color[o + 1] = A.g; color[o + 2] = A.b; color[o + 3] = A.a;
        i++;
      }
      drawInstances(this.progArrow, i);
    }

    gl.bindVertexArray(null);

    // ---------------------------------------------------------------------
    // 5) 标签（2D 叠加层，坐标为 CSS 像素）
    // ---------------------------------------------------------------------
    this._renderLabels(layers.labels || [], view);
  }

  _renderLabels(labels, view) {
    const ctx = this.labelCtx;
    const dpr = this.dpr;
    // 设备像素清屏
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    // 之后按 CSS 像素绘制，由变换统一乘 dpr，与 WebGL 层严格一致
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const T of labels) {
      if (T.alpha <= 0.004) continue;
      const screenX = (T.x * view.scale + view.panX) / dpr;
      const screenY = (T.y * view.scale + view.panY) / dpr;
      const fontPx = T.screenFont !== undefined ? T.screenFont : T.fontSize;
      ctx.font = `${fontPx}px ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.globalAlpha = Math.min(1, T.alpha);
      ctx.fillStyle = T.color;
      ctx.fillText(T.text, screenX, screenY);
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    const gl = this.gl;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  }
}

if (typeof module !== "undefined") module.exports = { GraphGLRenderer };
if (typeof self !== "undefined" && typeof module === "undefined") self.GraphGLRenderer = GraphGLRenderer;
