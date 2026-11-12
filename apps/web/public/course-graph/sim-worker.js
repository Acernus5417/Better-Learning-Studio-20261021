// User-supplied graph reimplementation, adapted for Studio; original comments retained.
/**
 * sim-worker.js — 图谱物理模拟 Worker（重写版）
 *
 * 逆向结论（对齐 Obsidian graph 的 /sim.js 行为）：
 *  - 每 1000/60 ms 一 tick（setTimeout 调度），alpha 从当前值向 alphaTarget 衰减，
 *    衰减率 = 1 - 0.001^(1/300)，alpha < 0.001 停表。
 *  - 力模型（与 d3-force 同构）：
 *      1) x/y 向心力：vx += (0 - x) * centerStrength * alpha
 *      2) link 力：strength = linkStrength / min(deg(s), deg(t))，1 次迭代，
 *         目标距离 linkDistance，两端按 deg 比例分配位移
 *      3) manyBody 斥力：Barnes-Hut 四叉树（theta 0.9），strength = -repelStrength，
 *         distanceMin = 30
 *      4) collide 碰撞：radius = 60（世界单位），strength = 0.5，1 次迭代
 *  - 积分：x += vx *= 0.6（velocityDecay 0.4），固定节点(fx/fy)位置锁定、速度清零。
 *  - 主线程只把"新增节点"的位置发来（旧节点传 false 保位）。
 *  - 输出：优先 SharedArrayBuffer（末 4 字节版本号，主线程读版本防撕裂），
 *          否则 transferable ArrayBuffer：{ id: string[], buffer: Float32Array(x,y,...) }
 *
 * 本文件为干净重写，不包含任何原始产品代码。
 */

"use strict";

// ---------------------------------------------------------------------------
// 状态与参数（默认值 = 原版默认值）
// ---------------------------------------------------------------------------
let alpha = 1;
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300); // ≈ 0.0228 / tick
let alphaTarget = 0;

let centerStrength = 0.1;
let linkStrength = 1;
let linkDistance = 250;
// 原版 sim.js 初始 x = -1e3：UI 滑杆(0-20)发送的是三次方，默认 10³ = 1000
let repelStrength = 1000;               // 实际使用 -repelStrength
const REPULSION_DISTANCE_MIN = 30;
const COLLIDE_RADIUS = 60;
const COLLIDE_STRENGTH = 0.5;
const VELOCITY_DECAY = 0.6;             // d3 velocityDecay=0.4 → 乘 0.6
const QUADTREE_THETA = 0.9;

const TICK_MS = 1000 / 60;
const ALPHA_MIN = 0.001;

let nodes = [];                         // [{id,x,y,vx,vy,fx,fy,index}]
const nodeById = new Map();
let links = [];                         // [{source,target,strength,distance,weightShare}]

let tickTimer = null;

// 轻量 LCG 随机源（确定性，避免 Math.random 大量调用）
let seed = 1;
function jiggle() {
  seed = (1664525 * seed + 1013904223) % 4294967296;
  return (seed / 4294967296 - 0.5) * 1e-6;
}

// ---------------------------------------------------------------------------
// 消息协议
//   { nodes: {id: [x,y] | false}, links: [[a,b], ...] }
//   { forceNode: {id, x|null, y|null} } —— 拖拽固定 / 解除
//   { forces: {centerStrength, linkStrength, linkDistance, repelStrength} }
//   { alpha, alphaTarget, run }
// ---------------------------------------------------------------------------
function handleSimMessage(event) {
  const msg = event.data;

  if (msg.nodes) {
    layoutEpoch = msg.epoch ?? layoutEpoch + 1;
    sharedBuffer = null;
    spareBuffers = [];
    allocatedBuffers = 0;
    pendingPositions = false;
    const incoming = msg.nodes;
    for (const id of Array.from(nodeById.keys())) {
      if (!Object.prototype.hasOwnProperty.call(incoming, id)) nodeById.delete(id);
    }
    nodes = [];
    for (const id in incoming) {
      if (!Object.prototype.hasOwnProperty.call(incoming, id)) continue;
      const pos = incoming[id];
      let node = nodeById.get(id);
      if (!node) {
        node = { id, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, index: 0 };
        nodeById.set(id, node);
      }
      if (pos && pos.length === 2) {           // false = 保留现有位置
        node.x = pos[0];
        node.y = pos[1];
        node.vx = node.vy = 0;
      }
      nodes.push(node);
    }
    for (let i = 0; i < nodes.length; i++) nodes[i].index = i;
    publishLayout();
  }

  if (msg.recycle && msg.epoch === layoutEpoch && msg.recycle.byteLength === nodes.length * 8) {
    spareBuffers.push(msg.recycle);
    if (pendingPositions) postPositions();
    return;
  }

  if (msg.links) {
    rebuildLinks(msg.links);
  }

  if (msg.forceNode) {
    const n = nodeById.get(msg.forceNode.id);
    if (n) {
      n.fx = msg.forceNode.x;
      n.fy = msg.forceNode.y;
    }
  }

  if (msg.forces) {
    const f = msg.forces;
    if (f.centerStrength !== undefined) centerStrength = f.centerStrength;
    if (f.linkStrength !== undefined) linkStrength = f.linkStrength;
    if (f.linkDistance !== undefined) linkDistance = f.linkDistance;
    if (f.repelStrength !== undefined) repelStrength = f.repelStrength;
    rebuildLinks(null); // 重算 strength / weightShare
  }

  if (msg.alpha !== undefined && alpha < msg.alpha) alpha = msg.alpha;
  if (msg.alphaTarget !== undefined) alphaTarget = msg.alphaTarget;
  if (msg.run) scheduleTick();
};

function rebuildLinks(pairs) {
  if (pairs) {
    links = [];
    for (const pair of pairs) {
      const s = nodeById.get(pair[0]);
      const t = nodeById.get(pair[1]);
      if (!s || !t || s === t) continue;
      links.push({ source: s, target: t, strength: 0, distance: linkDistance, weightShare: 0.5 });
    }
  }
  // 度数 → link 强度与两端分配比例
  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  for (const l of links) {
    const ds = degree.get(l.source) || 1;
    const dt = degree.get(l.target) || 1;
    l.strength = linkStrength / Math.min(ds, dt);
    l.distance = linkDistance;
    l.weightShare = ds / (ds + dt);
  }
}

// ---------------------------------------------------------------------------
// 调度：alpha > 0.001 时持续 tick
// ---------------------------------------------------------------------------
function scheduleTick() {
  if (!tickTimer) tickTimer = setTimeout(tick, TICK_MS);
}

function tick() {
  tickTimer = null;
  if (alpha <= ALPHA_MIN || nodes.length === 0) return;              // 冷却完毕
  alpha += (alphaTarget - alpha) * ALPHA_DECAY;
  scheduleTick();
  if (nodes.length === 0) return;
  simulateTick();
  postPositions();
}

function simulateTick() {
  applyCenterForces(alpha);
  applyLinkForces(alpha);
  applyRepulsion(alpha);
  applyCollisions();
  integrate();
}

function applyCenterForces(a) {
  for (const n of nodes) {
    n.vx += (0 - n.x) * centerStrength * a;
    n.vy += (0 - n.y) * centerStrength * a;
  }
}

function applyLinkForces(a) {
  for (const l of links) {
    const s = l.source, t = l.target;
    let dx = t.x + t.vx - s.x - s.vx;
    let dy = t.y + t.vy - s.y - s.vy;
    if (dx === 0) dx = jiggle();
    if (dy === 0) dy = jiggle();
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;
    const k = ((dist - l.distance) / dist) * a * l.strength;
    const fx = dx * k, fy = dy * k;
    t.vx -= fx * l.weightShare;
    t.vy -= fy * l.weightShare;
    s.vx += fx * (1 - l.weightShare);
    s.vy += fy * (1 - l.weightShare);
  }
}

// ---------------------------------------------------------------------------
// Barnes-Hut 四叉树（斥力 + 碰撞共用构建逻辑）
// ---------------------------------------------------------------------------
function buildQuadtree(withRadius) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.y > y1) y1 = n.y;
  }
  if (x0 > x1 || y0 > y1) return null;

  let half = Math.max(x1 - x0, y1 - y0) / 2 || 0.5;
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  while (cx - half > x0 || cx + half < x1 || cy - half > y0 || cy + half < y1) half *= 2;

  const root = {
    x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half,
    children: null, points: [], mass: 0, mx: 0, my: 0, r: 0,
  };
  for (const n of nodes) insertPoint(root, n, 0);
  summarize(root);
  if (withRadius) computeRadius(root);
  return root;

  function childIdx(q, x, y) {
    return (y >= (q.y0 + q.y1) / 2 ? 2 : 0) | (x >= (q.x0 + q.x1) / 2 ? 1 : 0);
  }
  function insertPoint(q, point, depth) {
    if (q.children) {
      pushIntoChild(q, point, depth);
    } else if (q.points.length === 0 || depth >= 24) {
      q.points.push(point);
    } else {
      q.children = [null, null, null, null];
      const existing = q.points;
      q.points = [];
      for (const p of existing) pushIntoChild(q, p, depth);
      pushIntoChild(q, point, depth);
    }
  }
  function pushIntoChild(q, point, depth) {
    const i = childIdx(q, point.x, point.y);
    const mx = (q.x0 + q.x1) / 2, my = (q.y0 + q.y1) / 2;
    if (!q.children[i]) {
      q.children[i] = {
        x0: i & 1 ? mx : q.x0, x1: i & 1 ? q.x1 : mx,
        y0: i & 2 ? my : q.y0, y1: i & 2 ? q.y1 : my,
        children: null, points: [], mass: 0, mx: 0, my: 0, r: 0,
      };
    }
    if (depth > 24) { q.children[i].points.push(point); return; }
    insertPoint(q.children[i], point, depth + 1);
  }
  function summarize(q) {
    if (q.children) {
      for (const c of q.children) if (c) summarize(c);
      for (const c of q.children) {
        if (!c || c.mass === 0) continue;
        q.mass += c.mass;
        q.mx += c.mx * c.mass;
        q.my += c.my * c.mass;
      }
      if (q.mass > 0) { q.mx /= q.mass; q.my /= q.mass; }
    } else if (q.points.length) {
      for (const p of q.points) { q.mass++; q.mx += p.x; q.my += p.y; }
      q.mx /= q.mass; q.my /= q.mass;
    }
  }
  function computeRadius(q) {
    if (q.children) {
      for (const c of q.children) if (c) computeRadius(c);
      for (const c of q.children) if (c && c.r > q.r) q.r = c.r;
    } else {
      q.r = withRadius; // 叶子半径 = 碰撞半径
    }
  }
}

// ---------------------------------------------------------------------------
// manyBody 斥力（Barnes-Hut，theta 0.9，distanceMin 30）
// ---------------------------------------------------------------------------
function applyRepulsion(a) {
  if (nodes.length === 0) return;
  const strength = -repelStrength;
  const tree = buildQuadtree(null);
  if (!tree) return;
  const theta2 = QUADTREE_THETA * QUADTREE_THETA;
  const dmin2 = REPULSION_DISTANCE_MIN * REPULSION_DISTANCE_MIN;

  for (const n of nodes) visit(tree, n);

  function farField(q, target) {
    const dx = q.mx - target.x;
    const dy = q.my - target.y;
    const width2 = (q.x1 - q.x0) ** 2;
    const d2 = dx * dx + dy * dy;
    return width2 / theta2 < d2;   // s/θ < d → 远场
  }

  function visit(q, target) {
    if (q.mass === 0) return;
    if (farField(q, target)) {
      let dx = q.mx - target.x, dy = q.my - target.y;
      let d2 = dx * dx + dy * dy;
      if (d2 >= dmin2) {
        if (dx === 0) { dx = jiggle(); d2 += dx * dx; }
        if (dy === 0) { dy = jiggle(); d2 += dy * dy; }
        if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
        const f = (q.mass * strength * a) / d2;
        target.vx += dx * f;
        target.vy += dy * f;
      }
      return;
    }
    if (q.children) {
      for (const c of q.children) if (c) visit(c, target);
      return;
    }
    for (const p of q.points) {
      if (p === target) continue;
      let dx = p.x - target.x, dy = p.y - target.y;
      let d2 = dx * dx + dy * dy;
      if (dx === 0) { dx = jiggle(); d2 += dx * dx; }
      if (dy === 0) { dy = jiggle(); d2 += dy * dy; }
      if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
      const f = (strength * a) / d2;
      target.vx += dx * f;
      target.vy += dy * f;
    }
  }
}

// ---------------------------------------------------------------------------
// collide 碰撞（radius 60，strength 0.5，1 次迭代）
// ---------------------------------------------------------------------------
function applyCollisions() {
  const r = COLLIDE_RADIUS;
  const tree = buildQuadtree(r);
  if (!tree) return;

  for (const a of nodes) visit(tree, a);

  function visit(q, target) {
    if (q.children) {
      const u = r + q.r;
      if (q.x0 > target.x + u || q.x1 < target.x - u || q.y0 > target.y + u || q.y1 < target.y - u) return;
      for (const c of q.children) if (c) visit(c, target);
      return;
    }
    for (const p of q.points) {
      if (p === target) continue;
      let dx = target.x + target.vx - p.x - p.vx;
      let dy = target.y + target.vy - p.y - p.vy;
      let d2 = dx * dx + dy * dy;
      const r2 = r * r;
      if (d2 >= r2) continue;
      if (dx === 0) { dx = jiggle(); d2 += dx * dx; }
      if (dy === 0) { dy = jiggle(); d2 += dy * dy; }
      const d = Math.sqrt(d2);
      const k = ((r - d) / d) * COLLIDE_STRENGTH;
      target.vx += dx * k;
      target.vy += dy * k;
      p.vx -= dx * k;
      p.vy -= dy * k;
    }
  }
}

// ---------------------------------------------------------------------------
// 积分（velocityDecay 0.4 → 乘 0.6；fx/fy 锁定）
// ---------------------------------------------------------------------------
function integrate() {
  for (const n of nodes) {
    if (n.fx === null) n.x += (n.vx *= VELOCITY_DECAY);
    else { n.x = n.fx; n.vx = 0; }
    if (n.fy === null) n.y += (n.vy *= VELOCITY_DECAY);
    else { n.y = n.fy; n.vy = 0; }
  }
}

// ---------------------------------------------------------------------------
// 模式判定：
//   - Worker 环境（importScripts 可用）→ 直接作为 worker 脚本
//   - 主线程环境（file:// 下 new Worker 被禁）→ 导出 createSimWorkerProxy()
//     提供与 Worker 相同的 postMessage/onmessage/terminate 接口，同步驱动
// ---------------------------------------------------------------------------
const IS_WORKER = typeof importScripts === "function";

let sharedBuffer = null;
let useShared = false;
let layoutEpoch = 0;
let spareBuffers = [], allocatedBuffers = 0, pendingPositions = false;
if (IS_WORKER) {
  try {
    if (self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      new SharedArrayBuffer(1);
      useShared = true;
    }
  } catch (e) { /* ignore */ }
}

let postPositionsTarget = null; // proxy 模式下的回调宿主

function emit(message, transfers) {
  if (IS_WORKER) postMessage(message, transfers || []);
  else if (postPositionsTarget) postPositionsTarget({ data: message });
}

// IDs and shared storage travel once per topology, never once per physics tick.
function publishLayout() {
  if (useShared) sharedBuffer = new SharedArrayBuffer(nodes.length * 8 + 4);
  emit({ type: "layout", epoch: layoutEpoch, id: nodes.map(node => node.id), buffer: sharedBuffer });
}

function postPositions() {
  const makeBuffer = (f32) => {
    for (let i = 0; i < nodes.length; i++) {
      f32[2 * i] = nodes[i].x;
      f32[2 * i + 1] = nodes[i].y;
    }
  };

  if (useShared) {
    const version = new Int32Array(sharedBuffer, sharedBuffer.byteLength - 4, 1);
    Atomics.add(version, 0, 1); // odd = writer owns this snapshot
    makeBuffer(new Float32Array(sharedBuffer, 0, nodes.length * 2));
    const v = Atomics.add(version, 0, 1) + 1; // even = complete snapshot
    emit({ type: "positions", epoch: layoutEpoch, v });
  } else {
    let buffer = spareBuffers.pop();
    if (!buffer) {
      if (IS_WORKER && allocatedBuffers >= 2) { pendingPositions = true; return; }
      buffer = new ArrayBuffer(nodes.length * 8);
      allocatedBuffers++;
    }
    pendingPositions = false;
    makeBuffer(new Float32Array(buffer));
    emit({ type: "positions", epoch: layoutEpoch, buffer }, [buffer]);
  }
}

if (!IS_WORKER && typeof self !== "undefined") {
  /**
   * 主线程模拟代理：接口对齐 Worker
   * worker = createSimWorkerProxy(); worker.postMessage(msg); worker.onmessage = fn;
   */
  self.createSimWorkerProxy = function () {
    const proxy = {
      onmessage: null,
      postMessage(msg) {
        handleSimMessage({ data: msg });
      },
      terminate() {
        if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
        postPositionsTarget = null;
      },
    };
    postPositionsTarget = (e) => { if (proxy.onmessage) proxy.onmessage(e); };
    return proxy;
  };
}

if (IS_WORKER) self.onmessage = handleSimMessage;
