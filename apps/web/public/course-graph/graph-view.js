// User-supplied graph reimplementation, adapted for Studio; original comments retained.
/**
 * graph-view.js — 图谱交互引擎（重写版）
 *
 * 职责对齐原版三个类：
 *  - h_（引擎主类）：渲染主循环、worker 结果应用、平移/缩放/键盘、视口裁剪、
 *    hover 判定、拖拽固定、空闲停帧（idleFrames > 60）
 *  - l_（节点）：尺寸 max(8, min(sqrt(weight+1)*3, 30))、淡入淡出、hover 减光、
 *    标签 14 + size/4、命中半径 size*nodeScale + 2
 *  - c_（连线）：从圆边缘画到圆边缘、厚度 lineSizeMult/scale、alpha 随
 *    (scale-0.3)*2 淡入、hover 高亮换色、可选箭头
 *
 * 动效常量（逆向所得）：
 *  - QU(current, target, damp=0.9)：逐帧指数逼近 —— 一切淡入淡出/缓动的基元
 *  - 淡出目标 alpha = 0.2（XU）
 *  - 缩放：targetScale ∈ [1/128, 8]，逐帧 0.85 逼近；滚轮因子 pow(1.5, -dy/120)
 *  - nodeScale = sqrt(1/scale)；textAlpha = clamp(log2(scale)+1-textFadeMult, 0, 1)
 *  - 键盘平移：速度 lerp 0.9，1000px/s，Shift ×3；键盘缩放每帧 ×(1+0.03|0.1)
 */

"use strict";

const GRAPH_REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
const GRAPH_LERP = (cur, target, damp = 0.9) => GRAPH_REDUCED_MOTION.matches ? target : cur * damp + target * (1 - damp);
// 与帧率无关的缓动：damp 是「60fps 下每帧保留比例」，k = 本帧耗时 / 16.67ms
function lerpDamp(cur, target, damp, k = 1) {
  if (GRAPH_REDUCED_MOTION.matches) return target;
  if (k === 1) return cur * damp + target * (1 - damp);
  return cur + (target - cur) * (1 - Math.pow(damp, k));
}
const GRAPH_FADE_DIM = 0.2;
// 高亮过渡的缓动系数（越小越柔和、越长）：颜色与标签位移比 alpha 更缓，避免突兀
const ANIM_COLOR_DAMP = 0.86;
const ANIM_MOVE_DAMP = 0.84;
// 文字缩放下限：sqrt(scale) 低于该值后字号固定，不再继续缩小
const MIN_TEXT_ZOOM = 0.62;
// 文字与节点圆之间的固定屏幕间距（CSS px），避免缩放后文字压到圆上
const TEXT_GAP_CSS = 5;
// 连线随缩小淡出：scale = LINE_FADE_FULL_SCALE 时完全不透明，
// 缩到 LINE_FADE_MIN_SCALE 时降到 LINE_FADE_MIN_ALPHA（变灰但不消失）
const LINE_FADE_MIN_SCALE = 0.08;
const LINE_FADE_FULL_SCALE = 0.85;
const LINE_FADE_MIN_ALPHA = 0.14;

function parseColor(input) {
  if (!input) return { r: 0.7, g: 0.7, b: 0.7, a: 1 };
  if (typeof input === "object") return input;
  const s = String(input).trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length === 8) hex = hex.slice(0, 6);
    const v = parseInt(hex, 16);
    return {
      r: ((v >> 16) & 255) / 255,
      g: ((v >> 8) & 255) / 255,
      b: (v & 255) / 255,
      a: 1,
    };
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  }
  return { r: 0.7, g: 0.7, b: 0.7, a: 1 };
}

const GRAPH_FONT_FAMILY =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", "Microsoft YaHei", sans-serif';

class GraphView {
  /**
   * @param {HTMLElement} containerEl 容器
   * @param {object} opts { workerUrl, workerFactory, onNodeClick, onNodeHover, onNodeUnhover }
   */
  constructor(containerEl, opts = {}) {
    this.containerEl = containerEl;
    this.opts = opts;
    this.onNodeClick = opts.onNodeClick || null;
    this.onNodeRightClick = opts.onNodeRightClick || null;
    this.onNodeHover = opts.onNodeHover || null;
    this.onNodeUnhover = opts.onNodeUnhover || null;

    // ---- DOM 结构：webgl 画布 + 标签叠加画布 ----
    containerEl.classList.add("kgv-root");
    containerEl.style.position = "relative";
    containerEl.style.overflow = "hidden";
    this.glCanvas = document.createElement("canvas");
    this.labelCanvas = document.createElement("canvas");
    for (const c of [this.glCanvas, this.labelCanvas]) {
      c.style.position = "absolute";
      c.style.left = "0";
      c.style.top = "0";
      containerEl.appendChild(c);
    }
    this.labelCanvas.style.pointerEvents = "none";

    this.renderer = new GraphGLRenderer(this.glCanvas, this.labelCanvas);

    // ---- 状态 ----
    this.nodes = [];            // NodeState[]
    this.nodeLookup = {};
    this.links = [];
    this.highlightNode = null;
    this.dragNode = null;

    this.scale = 1;
    this.targetScale = 1;
    this.nodeScale = 1;
    this.textAlpha = 1;
    this.panX = 0;
    this.panY = 0;
    this.panvX = 0;
    this.panvY = 0;
    this.zoomCenterX = 0;
    this.zoomCenterY = 0;
    this.viewport = null;
    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;

    this.keyboardActions = {};
    this.panning = false;
    this.mouseX = null;
    this.mouseY = null;

    this.idleFrames = 0;
    this.renderTimer = null;
    this.workerResults = null;
    this.layoutEpoch = 0;
    this.workerLayout = null;
    this.positionVersion = -1;
    this.renderCallback = () => this.renderFrame();
    // 帧间隔归一化系数（1 = 60fps），由主循环每帧更新，保证高刷屏上动画速度一致
    this.dtScale = 1;
    this._lastFrameTime = 0;

    // 显示选项
    this.fNodeSizeMult = 1;
    this.fLineSizeMult = 1;
    this.fTextShowMult = 0;
    this.fShowArrow = false;
    // 文字透明度下限：0 = 缩小到 scale≈0.5（log2(0.5)+1=0）时完全消失（与原版一致）。
    // 这与连线不同 —— 连线只淡出不消失，文字到阈值就隐藏。
    this.minTextAlpha = 0;

    // 主题色
    this.colors = this.readThemeColors();

    this._bindWorker();
    this._bindEvents();
    this.refreshTheme();

    this.changed();
  }

  // -------------------------------------------------------------------------
  // worker
  // -------------------------------------------------------------------------
  _bindWorker() {
    let worker = null;
    if (this.opts.workerUrl) {
      try {
        worker = new Worker(this.opts.workerUrl, { name: "Graph Worker" });
      } catch (e) {
        worker = null; // file:// 等场景
      }
    }
    if (!worker && this.opts.workerFactory) {
      worker = this.opts.workerFactory(); // 主线程兜底
    }
    this.worker = worker;
    if (!worker) return;
    worker.onmessage = (e) => {
      const message = e.data;
      if (message.epoch !== this.layoutEpoch) return;
      if (message.type === "layout") {
        this.workerLayout = message;
        this.positionVersion = -1;
        this.positionSnapshot = new Float32Array(message.id.length * 2);
      } else if (message.type === "positions") {
        this.recyclePositions(this.workerResults);
        this.workerResults = message;
        this.changed();
      }
    };
  }

  recyclePositions(result) {
    if (this.worker && result?.buffer instanceof ArrayBuffer && result.buffer.byteLength) {
      this.worker.postMessage({ recycle: result.buffer, epoch: result.epoch }, [result.buffer]);
    }
  }

  applyPositions() {
    const result = this.workerResults, layout = this.workerLayout;
    if (!result || !layout || result.epoch !== this.layoutEpoch) return;
    let positions;
    if (result.buffer instanceof ArrayBuffer) {
      positions = new Float32Array(result.buffer);
      this.workerResults = null;
    } else {
      const version = new Int32Array(layout.buffer, layout.buffer.byteLength - 4, 1);
      const before = Atomics.load(version, 0);
      if ((before & 1) || before === this.positionVersion) return;
      this.positionSnapshot.set(new Float32Array(layout.buffer, 0, layout.id.length * 2));
      if (before !== Atomics.load(version, 0)) return; // retry on the next frame
      this.positionVersion = before;
      positions = this.positionSnapshot;
    }
    for (let i = 0; i < layout.id.length; i++) {
      const node = this.nodeLookup[layout.id[i]];
      if (node) {
        node.x = node.fx === null ? positions[i * 2] : node.fx;
        node.y = node.fy === null ? positions[i * 2 + 1] : node.fy;
      }
    }
    if (this.opts.onPositions) this.opts.onPositions(positions);
    this.recyclePositions(result);
  }

  setFocusedNode(id) {
    if (this.focusedId === id) return;
    const previous = this.nodeLookup[this.focusedId];
    if (previous?.type === "focused") previous.type = "";
    const node = this.nodeLookup[id];
    if (node && node.type === "") node.type = "focused";
    this.focusedId = id;
    this.changed();
  }

  setForces(forces) {
    if (this.worker) this.worker.postMessage({ forces, alpha: 0.3, run: true });
  }

  setRenderOptions(o) {
    if (Number.isFinite(o.nodeSizeMultiplier)) this.fNodeSizeMult = o.nodeSizeMultiplier;
    if (Number.isFinite(o.lineSizeMultiplier)) this.fLineSizeMult = o.lineSizeMultiplier;
    if (Number.isFinite(o.textFadeMultiplier)) this.fTextShowMult = o.textFadeMultiplier;
    if (typeof o.showArrow === "boolean") this.fShowArrow = o.showArrow;
    this.changed();
  }

  // -------------------------------------------------------------------------
  // 数据增量更新（对齐原版 setData 语义）
  // -------------------------------------------------------------------------
  setData(data, initialPositions) {
    const existing = this.nodeLookup;
    const incoming = data.nodes || {};
    const weights = data.weights;

    const removed = [];
    const keepSet = {};
    let maxR2 = 0;

    for (const node of this.nodes) {
      if (Object.prototype.hasOwnProperty.call(incoming, node.id)) {
        keepSet[node.id] = false;
        if (node.x !== null && node.y !== null) {
          maxR2 = Math.max(maxR2, node.x * node.x + node.y * node.y);
        }
      } else {
        removed.push(node);
      }
    }

    let changed = false;
    let colorChanged = false;
    const added = [];

    for (const id in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, id)) continue;
      const spec = incoming[id];
      let node = existing[id];
      if (node) {
        if (node.color !== (spec.color || null)) { node.color = spec.color || null; colorChanged = true; }
        if (node.type !== spec.type) { node.type = spec.type; colorChanged = true; }
      } else {
        node = new KGNode(this, id, spec.type);
        node.color = spec.color || null;
        this.nodes.push(node);
        existing[id] = node;
        changed = true;
        added.push(node);
      }
    }

    // 移除失效边
    const dropped = new Set();
    const dropLink = (link) => {
      if (dropped.has(link)) return;
      dropped.add(link);
      link.clear();
      delete link.source.forward[link.target.id];
      delete link.target.reverse[link.source.id];
    };
    for (const node of this.nodes) {
      const wanted = incoming[node.id] ? incoming[node.id].links : {};
      for (const tid in node.forward) {
        if (!wanted[tid]) { dropLink(node.forward[tid]); changed = true; }
      }
      for (const tid in wanted) {
        if (!node.forward[tid] && existing[tid] && incoming[tid]) {
          const link = new KGLink(this, node, existing[tid]);
          this.links.push(link);
          node.forward[tid] = link;
          existing[tid].reverse[node.id] = link;
          changed = true;
        }
      }
    }

    // 删除孤立节点
    for (const node of removed) {
      for (const tid in node.forward) dropLink(node.forward[tid]);
      for (const tid in node.reverse) dropLink(node.reverse[tid]);
      delete existing[node.id];
      changed = true;
    }
    if (removed.length) this.nodes = this.nodes.filter(node => Object.prototype.hasOwnProperty.call(incoming, node.id));
    if (dropped.size) this.links = this.links.filter(link => !dropped.has(link));
    if (removed.includes(this.highlightNode)) this.highlightNode = null;
    if (removed.includes(this.dragNode)) this.dragNode = null;

    // 新节点初始位置：优先邻居质心附近，否则外环
    if (added.length > 0) {
      const area = added.length * 60 * 60;
      const maxR = Math.sqrt(maxR2);
      const extraR = Math.sqrt(area / Math.PI + maxR2) - maxR;
      const jitter = Math.sqrt(area);
      for (const node of added) {
        const saved = initialPositions?.[node.id];
        if (saved && saved.length === 2 && saved.every(Number.isFinite)) {
          node.x = saved[0]; node.y = saved[1];
          keepSet[node.id] = [node.x,node.y];
          continue;
        }
        let sx = 0, sy = 0, count = 0;
        for (const rid of node.getRelated()) {
          const rel = existing[rid];
          if (rel && rel.x !== null && rel.y !== null) { sx += rel.x; sy += rel.y; count++; }
        }
        if (count > 0) {
          node.x = sx / count + (Math.random() - 0.5) * jitter;
          node.y = sy / count + (Math.random() - 0.5) * jitter;
        } else {
          const ang = Math.random() * Math.PI * 2;
          const r = maxR + Math.sqrt(Math.random()) * extraR;
          node.x = r * Math.cos(ang);
          node.y = r * Math.sin(ang);
        }
        keepSet[node.id] = [node.x, node.y];
      }
    }

    // 权重
    for (const id in existing) {
      const node = existing[id];
      const w = weights ? (weights[id] !== undefined ? weights[id] : 0) : node.getRelated().length;
      if (node.weight !== w) { node.weight = w; changed = true; }
    }

    if (changed && this.worker) {
      this.recyclePositions(this.workerResults);
      this.workerResults = null;
      this.worker.postMessage({ epoch: ++this.layoutEpoch, nodes: keepSet, links: this.links.map((l) => [l.source.id, l.target.id]), alpha: 0.3, run: true });
    }
    if (changed || colorChanged) this.changed();
  }

  // -------------------------------------------------------------------------
  // 缩放 / 平移
  // -------------------------------------------------------------------------
  updateZoom() {
    let t = this.scale;
    let n = (this.targetScale = Math.min(8, Math.max(1 / 128, this.targetScale)));
    if (Math.abs(t > n ? t / n : n / t) - 1 >= 0.01) {
      let cx = this.zoomCenterX;
      let cy = this.zoomCenterY;
      if (cx === 0 && cy === 0) {
        cx = (this.width / 2) * this.dpr;
        cy = (this.height / 2) * this.dpr;
      }
      const pt = { x: (cx - this.panX) / t, y: (cy - this.panY) / t };
      t = lerpDamp(t, n, 0.85, this.dtScale);
      this.panX -= pt.x * t + this.panX - cx;
      this.panY -= pt.y * t + this.panY - cy;
      this.changed();
    }
    this.setPan(this.panX, this.panY);
    this.setScale(t);
  }

  setPan(x, y) { this.panX = x; this.panY = y; }
  setScale(s) {
    this.scale = s;
    this.nodeScale = Math.sqrt(1 / s);
    // 文字透明度：随缩放渐隐，但保留下限，缩小到一定程度后仍可读
    this.textAlpha = Math.min(1, Math.max(this.minTextAlpha, Math.log(s) / Math.LN2 + 1 - this.fTextShowMult));
  }

  zoomTo(scale, center) {
    this.targetScale = scale;
    if (center) { this.zoomCenterX = center.x; this.zoomCenterY = center.y; }
    else { this.zoomCenterX = this.zoomCenterY = 0; }
    this.changed();
  }

  resetPan() {
    this.setPan((this.width / 2) * this.dpr, (this.height / 2) * this.dpr);
  }

  onResize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.containerEl.clientWidth;
    const h = this.containerEl.clientHeight;
    this.width = w;
    this.height = h;
    this.renderer.resize(w, h, this.dpr);
    if (!this._panInitialized && w > 0 && h > 0) {
      this._panInitialized = true;
      this.resetPan();
    }
    this.changed();
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------
  _bindEvents() {
    const canvas = this.glCanvas;

    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("mousedown", (e) => e.preventDefault());
    canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    // pointermove 同样驱动 hover（部分设备/合成事件只发 pointer 系列）
    canvas.addEventListener("pointermove", (e) => {
      if (this.dragNode) return;
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
      this.updateHover();
    });
    canvas.addEventListener("mouseout", () => {
      this.mouseX = this.mouseY = null;
      this.updateHover();
    });

    let pointerDown = null;      // {x,y,worldX,worldY,node,moved}
    let dragMoved = false;

    canvas.addEventListener("pointerdown", (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能无效，忽略 */ }
      const world = this.screenToWorld(e.offsetX * this.dpr, e.offsetY * this.dpr);
      const hit = this.hitTest(world.x, world.y);
      pointerDown = { x: e.offsetX, y: e.offsetY, world, node: hit, moved: false };
      dragMoved = false;
      if (hit) {
        this.dragNode = hit;
        this.panning = false;
      } else {
        this.panning = true;
        document.body.classList.add("is-grabbing");
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!pointerDown) return;
      const dx = e.offsetX - pointerDown.x;
      const dy = e.offsetY - pointerDown.y;
      if (dx * dx + dy * dy > 25) dragMoved = true;

      if (this.dragNode && pointerDown.node) {
        const world = this.screenToWorld(e.offsetX * this.dpr, e.offsetY * this.dpr);
        this.dragNode.fx = world.x;
        this.dragNode.fy = world.y;
        if (this.worker) {
          this.worker.postMessage({
            alpha: 0.3,
            alphaTarget: 0.3,
            run: true,
            forceNode: { id: this.dragNode.id, x: world.x, y: world.y },
          });
        }
        this.changed();
      } else if (this.panning) {
        this.panX += dx * this.dpr;
        this.panY += dy * this.dpr;
        pointerDown.x = e.offsetX;
        pointerDown.y = e.offsetY;
        this.changed();
      }
    });

    const endPointer = (e) => {
      if (this.dragNode) {
        const node = this.dragNode;
        if (!dragMoved && e.type !== "pointercancel" && this.onNodeClick) {
          this.onNodeClick(node.id, node.type);
        }
        node.fx = null;
        node.fy = null;
        if (this.worker) {
          this.worker.postMessage({ alphaTarget: 0, forceNode: { id: node.id, x: null, y: null } });
        }
        this.dragNode = null;
        this.changed();
      }
      this.panning = false;
      pointerDown = null;
      document.body.classList.remove("is-grabbing");
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    canvas.addEventListener("contextmenu", (e) => {
      const world = this.screenToWorld(e.offsetX * this.dpr, e.offsetY * this.dpr);
      const hit = this.hitTest(world.x, world.y);
      if (hit && this.onNodeRightClick) {
        e.preventDefault();
        this.onNodeRightClick(e, hit.id, hit.type);
      }
    });

    window.addEventListener("blur", () => { this.keyboardActions = {}; this.panvX = this.panvY = 0; });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));

    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.onResize());
      this._ro.observe(this.containerEl);
    } else {
      window.addEventListener("resize", () => this.onResize());
    }
  }

  screenToWorld(px, py) {
    return { x: (px - this.panX) / this.scale, y: (py - this.panY) / this.scale };
  }

  onWheel(e) {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 40;
    else if (e.deltaMode === 2) dy *= 800;
    let target = this.targetScale * Math.pow(1.5, -dy / 120);
    this.targetScale = target;
    if (target < this.scale) {
      this.zoomCenterX = 0;
      this.zoomCenterY = 0;
    } else {
      this.zoomCenterX = e.offsetX * this.dpr;
      this.zoomCenterY = e.offsetY * this.dpr;
    }
    this.changed();
  }

  onMouseMove(e) {
    this.mouseX = e.offsetX;
    this.mouseY = e.offsetY;
    // hover 命中即时更新（事件驱动；渲染停帧时也有效，对齐原版 Pixi 事件行为）
    this.updateHover();
  }

  updateHover() {
    if (this.dragNode) return;
    let hit = null;
    if (this.mouseX !== null && this.mouseY !== null) {
      const w = this.screenToWorld(this.mouseX * this.dpr, this.mouseY * this.dpr);
      hit = this.hitTest(w.x, w.y);
    }
    if (hit !== this.highlightNode) {
      this.highlightNode = hit;
      this.idleFrames = 0;
      if (hit && this.onNodeHover) this.onNodeHover(hit.id, hit.type, this.mouseX, this.mouseY);
      if (!hit && this.onNodeUnhover) this.onNodeUnhover();
      this.changed();
    }
  }

  onKeyDown(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = this.keyboardActions;
    switch (e.key) {
      case "ArrowUp": k.up = true; break;
      case "ArrowDown": k.down = true; break;
      case "ArrowLeft": k.left = true; break;
      case "ArrowRight": k.right = true; break;
      case "+": case "=": k.zoomin = true; break;
      case "-": case "_": k.zoomout = true; break;
      default: return;
    }
    k.shift = e.shiftKey;
    e.preventDefault();
    this.changed();
  }

  onKeyUp(e) {
    const k = this.keyboardActions;
    switch (e.key) {
      case "ArrowUp": k.up = false; break;
      case "ArrowDown": k.down = false; break;
      case "ArrowLeft": k.left = false; break;
      case "ArrowRight": k.right = false; break;
      case "+": case "=": k.zoomin = false; break;
      case "-": case "_": k.zoomout = false; break;
    }
    k.shift = e.shiftKey;
  }

  // -------------------------------------------------------------------------
  // 命中 / hover
  // -------------------------------------------------------------------------
  hitTest(worldX, worldY) {
    // 命中半径：取「节点实际半径」与「最小可点半径（12 CSS px）」的较大者，
    // 再留 2px 容差 —— 小节点也能轻松悬停，避免“放上去没反应”
    const minR = (12 * this.dpr) / this.scale;
    const tol = (2 * this.dpr) / this.scale;
    let best = null;
    let bestD = Infinity;
    for (const node of this.nodes) {
      if (node.x === null || node.y === null) continue;
      const r = Math.max(node.getSize() * this.nodeScale, minR) + tol;
      const dx = node.x - worldX;
      const dy = node.y - worldY;
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestD) { bestD = d; best = node; }
    }
    return best;
  }

  getHighlightNode() {
    return this.dragNode || this.highlightNode;
  }

  // -------------------------------------------------------------------------
  // 主题色（CSS 变量 → 渲染色）
  // -------------------------------------------------------------------------
  readThemeColors() {
    const css = getComputedStyle(this.containerEl);
    const read = (name, fallback) => {
      const v = css.getPropertyValue(name).trim();
      return parseColor(v || fallback);
    };
    return {
      fill: read("--kgv-color-fill", "#b0b0b0"),
      fillFocused: read("--kgv-color-fill-focused", "#a882ff"),
      fillTag: read("--kgv-color-fill-tag", "#a882ff"),
      fillUnresolved: read("--kgv-color-fill-unresolved", "#585858"),
      fillAttachment: read("--kgv-color-fill-attachment", "#3aa0a0"),
      fillHighlight: read("--kgv-color-fill-highlight", "#ffffff"),
      line: read("--kgv-color-line", "#4a4a4a"),
      lineHighlight: read("--kgv-color-line-highlight", "#9a9a9a"),
      circle: read("--kgv-color-circle", "#dbdbdb"),
      text: read("--kgv-color-text", "#dadada"),
      arrow: read("--kgv-color-arrow", "#a3a3a3"),
    };
  }

  refreshTheme() {
    this.colors = this.readThemeColors();
    this.changed();
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------
  changed() {
    this.idleFrames = 0;
    this.queueRender();
  }

  /**
   * 标签避让：按优先级（hover 最高，其次节点权重）依次放置，
   * 与已放置标签在屏幕空间相交则跳过 —— 缩小时不会糊成一片。
   */
  _layoutLabels(labels) {
    if (labels.length === 0) return labels;
    // 文字淡出到 0 后（scale < ~0.5）labels 本身已为空，这里只需处理可见标签的避让
    const cell = 48;
    const buckets = new Map();
    const out = [];
    const sorted = labels.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const T of sorted) {
      const isHover = (T.priority || 0) >= 1e9;

      const sx = (T.x * this.scale + this.panX) / this.dpr;
      const sy = (T.y * this.scale + this.panY) / this.dpr;
      const font = T.screenFont;
      // 文本盒估算：中文全角约 1em、拉丁约 0.55em，取 0.78 折中
      const w = Math.max(8, T.text.length * font * 0.78) + 3;
      const h = font * 1.18;
      const r = { x0: sx - w / 2, x1: sx + w / 2, y0: sy - 1, y1: sy + h };

      // 完全在视口外则丢弃
      if (r.x1 < 0 || r.x0 > this.width || r.y1 < 0 || r.y0 > this.height) continue;

      const gx0 = Math.floor(r.x0 / cell), gx1 = Math.floor(r.x1 / cell);
      const gy0 = Math.floor(r.y0 / cell), gy1 = Math.floor(r.y1 / cell);
      let clash = false;
      for (let gx = gx0; gx <= gx1 && !clash; gx++) {
        for (let gy = gy0; gy <= gy1 && !clash; gy++) {
          const arr = buckets.get(gx + "," + gy);
          if (!arr) continue;
          for (const o of arr) {
            if (o.x0 < r.x1 && o.x1 > r.x0 && o.y0 < r.y1 && o.y1 > r.y0) { clash = true; break; }
          }
        }
      }
      if (clash) {
        // hover 的标签强制显示
        if (isHover) out.push(T);
        continue;
      }
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const k = gx + "," + gy;
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        }
      }
      out.push(T);
    }
    return out;
  }

  queueRender() {
    if (!this.renderTimer && typeof this.renderCallback === "function") {
      this.renderTimer = requestAnimationFrame(this.renderCallback);
    }
  }

  renderFrame() {
    this.renderTimer = null;
    if (this.idleFrames > 60) { if(this.opts.onIdle)this.opts.onIdle(); return; }

    // 帧间时间归一化（rAF 天然与屏幕刷新率同步；这里把动画改成时间步长驱动，
    // 使 120Hz/144Hz 屏上的过渡速度与 60Hz 一致）
    const now = performance.now();
    const dt = this._lastFrameTime ? now - this._lastFrameTime : 16.667;
    this._lastFrameTime = now;
    this.dtScale = dt > 100 ? 1 : Math.min(3, Math.max(0.35, dt / 16.667));

    this.applyPositions();

    // --- 键盘平移/缩放 ---
    if (!this.panning) {
      this.panX += (this.panvX * 1000) / 60;
      this.panY += (this.panvY * 1000) / 60;
      let wx = 0, wy = 0;
      const k = this.keyboardActions;
      if (k.up) wy += 1;
      if (k.down) wy -= 1;
      if (k.left) wx += 1;
      if (k.right) wx -= 1;
      if (wx !== 0 || wy !== 0) this.idleFrames = 0;
      const boost = k.shift ? 3 : 1;
      this.panvX = lerpDamp(this.panvX, wx * boost, 0.9, this.dtScale);
      this.panvY = lerpDamp(this.panvY, wy * boost, 0.9, this.dtScale);
    }
    {
      const k = this.keyboardActions;
      const factor = 1 + (k.shift ? 0.1 : 0.03);
      let zoomed = false;
      if (k.zoomin) { this.targetScale *= factor; zoomed = true; }
      if (k.zoomout) { this.targetScale /= factor; zoomed = true; }
      if (zoomed) {
        this.idleFrames = 0;
        this.zoomCenterX = (this.width / 2) * this.dpr;
        this.zoomCenterY = (this.height / 2) * this.dpr;
      }
    }
    this.updateZoom();

    // --- 视口 ---
    const dpr = this.dpr;
    const vl = -this.panX / this.scale;
    const vt = -this.panY / this.scale;
    const vr = vl + (this.width / this.scale) * dpr;
    const vb = vt + (this.height / this.scale) * dpr;
    this.viewport = { left: vl, right: vr, top: vt, bottom: vb };

    // --- 组装绘制列表 ---
    const highlight = this.getHighlightNode();
    const nodeScale = this.nodeScale;
    const glNodes = [];
    const glLinks = [];
    const glRings = [];
    const glArrows = [];
    const glLabels = [];
    const circleColor = this.colors.circle;
    let animating = false;

    for (const node of this.nodes) {
      if (node.renderFrame(highlight, nodeScale, glNodes, glLabels, glRings)) animating = true;
    }
    for (const link of this.links) {
      if (link.renderFrame(highlight, nodeScale, glLinks, glArrows)) animating = true;
    }

    this.renderer.render({
      view: { scale: this.scale, panX: this.panX, panY: this.panY },
      links: glLinks,
      nodes: glNodes,
      rings: glRings,
      arrows: glArrows,
      labels: this._layoutLabels(glLabels),
    });

    this.idleFrames++;
    // 过渡动画未收敛时保持渲染（否则 hover 高亮/标签位移可能被停帧打断在半途）
    if (animating) this.idleFrames = 0;
    this.queueRender();

    // --- hover 持续校正：布局活动时节点可能移到指针下方/移出 ---
    if (!this.dragNode) this.updateHover();
  }

  destroy() {
    this.renderCallback = null;
    if (this.worker) { this.worker.onmessage = null; this.worker.terminate(); }
    if (this._ro) this._ro.disconnect();
    if (this.renderTimer) cancelAnimationFrame(this.renderTimer);
    this.renderer.destroy();
    this.glCanvas.remove();
    this.labelCanvas.remove();
    document.body.classList.remove("is-grabbing");
  }
}

// ---------------------------------------------------------------------------
// 节点状态
// ---------------------------------------------------------------------------
class KGNode {
  constructor(view, id, type) {
    this.view = view;
    this.id = id;
    this.type = type || "";
    this.x = null;
    this.y = null;
    this.fx = null;
    this.fy = null;
    this.forward = {};   // id -> KGLink
    this.reverse = {};   // id -> KGLink
    this.weight = 0;
    this.color = null;
    this.fadeAlpha = 0;
    this.moveText = 0;
    this.curFill = null;   // 当前渲染填充色（逐帧渐变）
    const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    this.label = base.replace(/\.md$/i, "");
  }

  getRelated() {
    return Object.keys(this.forward).concat(Object.keys(this.reverse));
  }

  getSize() {
    return this.view.fNodeSizeMult * Math.max(8, Math.min(Math.sqrt(this.weight + 1) * 3, 30));
  }

  getFillColor() {
    const colors = this.view.colors;
    const h = this.view.getHighlightNode();
    // 选中：本节点与其直接相邻节点都使用选中色（默认 Obsidian 紫）
    if (h) {
      if (h === this) return colors.fillHighlight;
      if (this.forward[h.id] || this.reverse[h.id]) return colors.fillHighlight;
    }
    if (this.type === "focused" && colors.fillFocused.a > 0) return colors.fillFocused;
    if (this.color) return parseColor(this.color);
    if (this.type === "tag") return colors.fillTag;
    if (this.type === "unresolved") return colors.fillUnresolved;
    if (this.type === "attachment") return colors.fillAttachment;
    return colors.fill;
  }

  displayText() {
    // 原版只显示文件名（去掉目录与 .md），不是完整路径
    return this.label;
  }

  renderFrame(highlight, nodeScale, outNodes, outLabels, outRings) {
    if (this.x === null || this.y === null) return;
    const view = this.view;
    const colors = view.colors;
    const size = this.getSize();
    const vp = view.viewport;
    const radius = size * nodeScale;
    // Include label bounds: a node just outside the viewport may have visible text.
    const margin = Math.max(radius, this.label.length * (14 + size / 4) * Math.max(Math.sqrt(view.scale), MIN_TEXT_ZOOM) * view.dpr / view.scale);
    if (vp && (this.x + margin < vp.left || this.x - margin > vp.right || this.y + radius + 80 * view.dpr / view.scale < vp.top || this.y - radius > vp.bottom)) return false;
    const fill = this.getFillColor();
    const hovered = highlight === this;

    // 高亮语义：自己、邻居、或无高亮 → 全亮；否则减光到 0.2
    let alphaGoal = GRAPH_FADE_DIM;
    if (!highlight || hovered || this.forward[highlight.id] || this.reverse[highlight.id]) {
      alphaGoal = 1;
    }
    this.fadeAlpha = lerpDamp(this.fadeAlpha, alphaGoal, 0.9, view.dtScale);
    const alpha = this.fadeAlpha * fill.a;

    // 颜色也逐帧渐变（等价原版 tint 的 $U 逐帧 lerp）：
    // 否则 hover 时填充色从灰到纯白是瞬间切换，观感突兀
    if (!this.curFill) this.curFill = { r: fill.r, g: fill.g, b: fill.b };
    this.curFill.r = lerpDamp(this.curFill.r, fill.r, ANIM_COLOR_DAMP, view.dtScale);
    this.curFill.g = lerpDamp(this.curFill.g, fill.g, ANIM_COLOR_DAMP, view.dtScale);
    this.curFill.b = lerpDamp(this.curFill.b, fill.b, ANIM_COLOR_DAMP, view.dtScale);

    // 标签 alpha
    let textA = view.textAlpha * this.fadeAlpha * colors.text.a;
    if (hovered) textA = 1 * colors.text.a;

    // hover 时标签向下缓移 15（屏幕像素），表示该节点被选中
    const moveGoal = hovered ? 15 : 0;
    this.moveText = lerpDamp(this.moveText, moveGoal, ANIM_MOVE_DAMP, view.dtScale);

    // 字号按「屏幕像素」给定：随 sqrt(scale) 缓放，但有下限（缩小到一定程度后固定）；
    // hover 时不低于基础字号，避免缩小后悬停文字反而变小
    const baseFont = 14 + size / 4;
    const zoomF = Math.max(Math.sqrt(view.scale), MIN_TEXT_ZOOM);
    let screenFont = baseFont * zoomF;
    if (hovered) screenFont = Math.max(screenFont, baseFont);

    // 文字与圆的间距用屏幕像素固定，缩放时不会压到节点上
    const textY = this.y + size * nodeScale + (TEXT_GAP_CSS + this.moveText) / view.scale;

    if (!vp || !(this.x + radius < vp.left || this.x - radius > vp.right || this.y + radius < vp.top || this.y - radius > vp.bottom)) outNodes.push({
      x: this.x, y: this.y,
      radius: size * nodeScale, // 世界半径
      r: this.curFill.r, g: this.curFill.g, b: this.curFill.b, a: alpha,
    });

    // 标签裁剪：世界坐标 ±300（缩小后由下方的屏幕空间避让统一处理重叠）
    const showText =
      textA > 0.004 &&
      (hovered || !(vp && (this.x + 300 < vp.left || this.x - 300 > vp.right || textY + 200 < vp.top || textY - 200 > vp.bottom)));
    if (showText) {
      outLabels.push({
        x: this.x, y: textY,
        text: this.displayText(),
        screenFont,
        alpha: textA,
        color: rgbCss(colors.text),
        // 避让优先级：hover 最高，其余按权重
        priority: hovered ? 1e9 : this.weight,
      });
    }

    if (hovered) {
      const width = Math.max(1, 1 / (view.scale * nodeScale)) / view.scale;
      // 高亮环用「选中色」（默认 Obsidian 紫），而不是黑白描边
      const ringColor = colors.fillHighlight;
      outRings.push({
        x: this.x, y: this.y,
        radius: size * nodeScale,
        width,
        r: ringColor.r, g: ringColor.g, b: ringColor.b, a: ringColor.a,
      });
    }

    // 过渡是否仍在进行（供主循环决定是否续帧）
    return (
      Math.abs(this.fadeAlpha - alphaGoal) > 0.004 ||
      Math.abs(this.moveText - moveGoal) > 0.4 ||
      Math.abs(this.curFill.r - fill.r) > 0.004 ||
      Math.abs(this.curFill.g - fill.g) > 0.004 ||
      Math.abs(this.curFill.b - fill.b) > 0.004
    );
  }
}

// ---------------------------------------------------------------------------
// 连线状态
// ---------------------------------------------------------------------------
class KGLink {
  constructor(view, source, target) {
    this.view = view;
    this.source = source;
    this.target = target;
    this.alpha = 0;
    this.arrowAlpha = 0;
  }

  clear() { /* 无持久 GPU 资源 */ }

  renderFrame(highlight, nodeScale, outLinks, outArrows) {
    const view = this.view;
    const o = this.source, a = this.target;
    if (o.x === null || o.y === null || a.x === null || a.y === null) return;
    const vp = view.viewport, margin = (8 * Math.sqrt(view.fLineSizeMult) + view.fLineSizeMult) / view.scale;
    // Keep crossing edges even when both endpoints are outside the viewport.
    if (vp && (Math.max(o.x, a.x) + margin < vp.left || Math.min(o.x, a.x) - margin > vp.right || Math.max(o.y, a.y) + margin < vp.top || Math.min(o.y, a.y) - margin > vp.bottom)) return false;
    const isAdjacent = highlight && (o === highlight || a === highlight);
    let goal = isAdjacent || !highlight ? 1 : GRAPH_FADE_DIM;
    let lineColor = isAdjacent ? view.colors.fillHighlight : view.colors.line;

    // 随缩放淡入，但有下限：缩小后连线不能被隐藏
    // 缩小淡出：随缩放线性变淡（类似淡出动画），但保留下限 —— 再小也不会消失，
    // 只是变灰、变弱，仍然能看出连接关系
    const fadeT = Math.min(1, Math.max(0, (view.scale - LINE_FADE_MIN_SCALE) / (LINE_FADE_FULL_SCALE - LINE_FADE_MIN_SCALE)));
    const zoomFade = LINE_FADE_MIN_ALPHA + (1 - LINE_FADE_MIN_ALPHA) * fadeT;
    const alpha = goal * zoomFade * lineColor.a;
    this.alpha = lerpDamp(this.alpha, alpha, 0.9, view.dtScale);

    const arrowColor = view.colors.arrow;
    const arrowGoal = view.fShowArrow && (isAdjacent || !highlight) ? zoomFade * arrowColor.a : 0;
    this.arrowAlpha = lerpDamp(this.arrowAlpha, arrowGoal, 0.9, view.dtScale);

    // 连线颜色也逐帧渐变（高亮边由暗灰过渡到亮灰）
    if (!this.curLine) this.curLine = { r: lineColor.r, g: lineColor.g, b: lineColor.b };
    this.curLine.r = lerpDamp(this.curLine.r, lineColor.r, ANIM_COLOR_DAMP, view.dtScale);
    this.curLine.g = lerpDamp(this.curLine.g, lineColor.g, ANIM_COLOR_DAMP, view.dtScale);
    this.curLine.b = lerpDamp(this.curLine.b, lineColor.b, ANIM_COLOR_DAMP, view.dtScale);

    const dx = a.x - o.x;
    const dy = a.y - o.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const thickness = view.fLineSizeMult / view.scale;
    // 线端略微伸入圆内（0.6 设备像素），消除线端与圆 AA 边缘之间的半像素缝隙
    const inset = 0.6 / view.scale;
    const r1 = Math.max(0, o.getSize() * nodeScale - inset);
    const r2 = Math.max(0, a.getSize() * nodeScale - inset);

    if (dist > 0) {
      outLinks.push({
        x1: o.x + (dx * r1) / dist,
        y1: o.y + (dy * r1) / dist,
        x2: a.x - (dx * r2) / dist,
        y2: a.y - (dy * r2) / dist,
        thickness,
        r: this.curLine.r, g: this.curLine.g, b: this.curLine.b,
        a: this.alpha,
      });

      // 箭头：目标圆边缘外 1 世界单位
      const showArrow = view.fShowArrow && dist > thickness && this.arrowAlpha > 0.004;
      if (showArrow) {
        const tipDist = r2 + 1;
        outArrows.push({
          x: a.x - (dx * tipDist) / dist,
          y: a.y - (dy * tipDist) / dist,
          angle: Math.atan2(dy, dx),
          size: (4 * Math.sqrt(view.fLineSizeMult)) / view.scale,
          r: arrowColor.r, g: arrowColor.g, b: arrowColor.b,
          a: this.arrowAlpha,
        });
      }
    }

    return (
      Math.abs(this.alpha - alpha) > 0.004 ||
      Math.abs(this.arrowAlpha - arrowGoal) > 0.004 ||
      Math.abs(this.curLine.r - lineColor.r) > 0.004 ||
      Math.abs(this.curLine.g - lineColor.g) > 0.004 ||
      Math.abs(this.curLine.b - lineColor.b) > 0.004
    );
  }
}

function rgbCss(c) {
  const to255 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${to255(c.r)},${to255(c.g)},${to255(c.b)},${c.a})`;
}

if (typeof module !== "undefined") module.exports = { GraphView, KGNode, KGLink, parseColor };
if (typeof self !== "undefined" && typeof module === "undefined") {
  self.GraphView = GraphView;
  self.parseColor = parseColor;
}
