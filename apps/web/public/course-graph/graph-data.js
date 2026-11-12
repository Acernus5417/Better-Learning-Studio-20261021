// User-supplied graph reimplementation, adapted for Studio; original comments retained.
/**
 * graph-data.js — 图谱数据构建器（重写版）
 *
 * 对齐原版行为（逆向结论）：
 *  1) 全局图：遍历 metadataCache（文件 → resolvedLinks / unresolvedLinks / tags）
 *     - 附件是否显示由 showAttachments 控制；附件节点 type="attachment"
 *     - 未解析链接（双链指向不存在的文件）→ type="unresolved" 的节点 + 一条边
 *     - 标签 → type="tag" 的节点 + 一条边（标签名大小写归一）
 *     - 孤立节点（无边）由 showOrphans 控制是否保留
 *     - 搜索/分组：每个查询对象 {query, color}；匹配任一带色查询 → 节点着色；
 *       节点必须匹配所有"无色"查询才会保留
 *     - timelapse（progression）：按文件 ctime 升序回放，progression 限制
 *       节点+边 的累计数量上限
 *  2) 局部图：从 localFile 出发，按 localJumps 跳数 BFS；
 *     每往外一跳，节点 weight 递减（30, 30-30/jumps, ...）；
 *     localForelinks / localBacklinks / localInterlinks 分别控制
 *     出边 / 入边 / 中间节点自身的完整链接
 *  3) 节点权重：全局图 = 度数（相关节点数）；局部图 = 上面递减的 weight，
 *     权重决定节点渲染尺寸 max(8, min(sqrt(w+1)*3, 30))
 */

"use strict";

/** @typedef {{path:string, links:{target:string, resolved:boolean}[], tags:string[], ctime:number, isAttachment:boolean}} NoteRecord */

const DEFAULT_OPTIONS = {
  showAttachments: false,
  hideUnresolved: false,
  showTags: false,
  showOrphans: false,
  // 搜索查询：{query: {matchFilepath(path), matchTag(tag)}, color: '#hex'|null}
  searchQueries: [],
  hasFilter: false,
  // 局部图
  localFile: null,
  localJumps: 1,
  localForelinks: true,
  localBacklinks: true,
  localInterlinks: false,
  // timelapse
  progression: 0, // 0 = 不限制
  focusFile: null,
};

class GraphDataBuilder {
  constructor() {
    this.notes = new Map(); // path -> NoteRecord
  }

  /** 全量/增量设置笔记元数据 */
  setNotes(noteList) {
    this.notes = new Map();
    this.tagNames = new Map();
    for (const n of noteList) {
      this.notes.set(n.path, n);
      for(const tag of n.tags || [])if(!this.tagNames.has(tag.toLowerCase()))this.tagNames.set(tag.toLowerCase(),tag);
    }
    return this;
  }

  /**
   * 构建图数据
   * @returns {{nodes: Object<string,{type:string,color:?string,links:Object<string,boolean>}>, weights: ?Object<string,number>}}
   */
  build(options) {
    const opt = { ...DEFAULT_OPTIONS, ...options };
    if (opt.localFile) {
      return this.buildLocal(opt);
    }
    const graph = this.buildGlobal(opt);
    if (!opt.showOrphans) this.removeOrphans(graph);
    return graph;
  }

  // -------------------------------------------------------------------------
  // 全局图
  // -------------------------------------------------------------------------
  buildGlobal(opt) {
    const queries = opt.searchQueries || [];
    const showAttachments = opt.showAttachments;
    const hideUnresolved = opt.hideUnresolved;
    const showTags = opt.showTags;
    const cap = opt.progression || 0; // timelapse：节点+边累计上限

    // 按 ctime 升序（timelapse 回放顺序；平时无关紧要）
    const paths = [...this.notes.keys()].sort((a, b) => {
      const na = this.notes.get(a), nb = this.notes.get(b);
      return (na.ctime || 0) - (nb.ctime || 0);
    });

    const nodes = {};
    let f = 0;                 // 累计计数（节点+边）
    let truncIdx = -1;         // 截断文件下标：之后的文件整体删除（对齐原版语义）

    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];
      const note = this.notes.get(path);
      const isAttachment = !!note.isAttachment;
      if (!showAttachments && isAttachment) continue;

      // 搜索 / 分组匹配
      let color = null;
      let keep = true;
      for (const q of queries) {
        const matched = this.matchQuery(q, path, "file");
        if (!matched && !q.color) { keep = false; break; }
        if (matched && q.color) { color = q.color; break; }
      }
      if (!keep) continue;

      // 节点始终加入（原版语义）；计数器在 cap 模式下记录截断点
      const node = (nodes[path] = { type: isAttachment ? "attachment" : "", color, links: {} });
      if (cap) {
        if (f === cap && truncIdx < 0) truncIdx = pi;
        f++;
      }

      // 已解析链接 → 边（cap 模式下受预算限制）
      for (const link of note.links || []) {
        if (!link.resolved) continue;
        const target = link.target;
        const tNote = this.notes.get(target);
        const tIsAttachment = tNote ? !!tNote.isAttachment : false;
        if (!showAttachments && tIsAttachment) continue;
        if (tIsAttachment) {
          let ok = true;
          for (const q of queries) {
            const m = this.matchQuery(q, target, "file");
            if (!m && !q.color) { ok = false; break; }
          }
          if (!ok) continue;
        }
        if (cap) {
          if (f < cap) { node.links[target] = true; f++; }
        } else {
          node.links[target] = true;
        }
      }

      // 未解析链接 → unresolved 节点
      if (!hideUnresolved) {
        for (const link of note.links || []) {
          if (link.resolved) continue;
          const target = link.target;
          if (cap) {
            if (f >= cap) continue;
            f++;
          }
          node.links[target] = true;
          if (!nodes[target]) nodes[target] = { type: "unresolved", color: null, links: {} };
        }
      }

      // 标签 → tag 节点
      if (showTags) {
        for (const rawTag of note.tags || []) {
          const tag=this.tagNames.get(rawTag.toLowerCase()) || rawTag;
          if (cap) {
            if (f >= cap) continue;
            f++;
          }
          node.links["#" + tag] = true;
          if (!nodes["#" + tag]) nodes["#" + tag] = { type: "tag", color: null, links: {} };
        }
      }
    }

    // 截断：删除截断文件之后的所有文件节点
    if (truncIdx >= 0) {
      for (let pi = truncIdx + 1; pi < paths.length; pi++) {
        delete nodes[paths[pi]];
      }
    }

    // Drop edges to filtered nodes before testing isolation.
    for (const node of Object.values(nodes)) for (const target of Object.keys(node.links)) if (!Object.hasOwn(nodes, target)) delete node.links[target];
    return { nodes, weights: null };
  }

  matchQuery(q, path, kind) {
    if (kind === "file") return q.query.matchFilepath(path);
    if (kind === "tag") return q.query.matchTag(path);
    return false;
  }

  // -------------------------------------------------------------------------
  // 局部图：从 localFile BFS，weight 按跳数递减
  // -------------------------------------------------------------------------
  buildLocal(opt) {
    const nodes = {};
    const weights = {};
    const root = opt.localFile;
    const jumps = Math.max(1, opt.localJumps | 0);
    const rootNote = this.notes.get(root);

    weights[root] = 30;
    if (!rootNote) {
      nodes[root] = { type: "", color: null, links: {} };
      return { nodes, weights };
    }

    // 已解析的邻接表（正/反向）
    const forward = new Map(); // path -> Set(path)
    const backward = new Map();
    for (const [path, note] of this.notes) {
      for (const link of note.links || []) {
        if (!link.resolved) continue;
        if (!this.notes.has(link.target)) continue;
        if (!forward.has(path)) forward.set(path, new Set());
        forward.get(path).add(link.target);
        if (!backward.has(link.target)) backward.set(link.target, new Set());
        backward.get(link.target).add(path);
      }
    }

    const addNode = (path, type) => {
      if (!nodes[path]) nodes[path] = { type: type || "", color: null, links: {} };
      return nodes[path];
    };
    addNode(root, "");

    // BFS：第 k 跳的节点 weight = 30 - (30/jumps)*(k)
    let frontier = new Set([root]);
    for (let hop = 1; hop <= jumps; hop++) {
      const weight = 30 - (30 / jumps) * hop;
      const next = new Set();
      for (const cur of frontier) {
        const node = nodes[cur];
        // forelinks（出边）：边记在新节点上（指向回源），与原版 p_ 语义一致
        if (opt.localForelinks && forward.has(cur)) {
          for (const t of forward.get(cur)) {
            if (nodes[t]) continue;
            if (this.notes.get(t) && this.notes.get(t).isAttachment) continue;
            addNode(t, "");
            node.links[t] = true;
            next.add(t);
            weights[t] = weight;
          }
        }
        // backlinks（入边）
        if (opt.localBacklinks && backward.has(cur)) {
          for (const s of backward.get(cur)) {
            if (nodes[s]) continue;
            if (this.notes.get(s) && this.notes.get(s).isAttachment) continue;
            const sn = addNode(s, "");
            sn.links[cur] = true;
            next.add(s);
            weights[s] = weight;
          }
        }
      }
      frontier = next;
    }

    // interlinks：让已入选节点显示其全部链接（含与图中其他节点的边）
    if (opt.localInterlinks) {
      for (const path in nodes) {
        if (forward.has(path)) {
          for (const t of forward.get(path)) {
            if (nodes[t]) nodes[path].links[t] = true;
          }
        }
      }
    }

    return { nodes, weights };
  }

  // -------------------------------------------------------------------------
  // 去孤立节点：没有任何（双向）边的节点删除
  // -------------------------------------------------------------------------
  removeOrphans(graph) {
    const nodes = graph.nodes;
    const referenced = {};
    for (const id in nodes) {
      const links = nodes[id].links;
      for (const t in links) {
        if (t !== id) referenced[t] = true;
      }
    }
    for (const id in nodes) {
      const links = nodes[id].links;
      let hasEdge = false;
      for (const t in links) {
        if (t !== id && nodes.hasOwnProperty(t)) { hasEdge = true; break; }
      }
      if (!hasEdge && !referenced[id]) delete nodes[id];
    }
  }

  // -------------------------------------------------------------------------
  // 度数权重（全局图默认）：出度 + 入度，单趟 O(N+E)
  // -------------------------------------------------------------------------
  static computeWeights(nodes) {
    const weights = {};
    for (const id in nodes) weights[id] = 0;
    for (const id in nodes) {
      const links = nodes[id].links;
      weights[id] += Object.keys(links).length;
      for (const t in links) {
        if (weights[t] !== undefined) weights[t] += 1;
      }
    }
    return weights;
  }
}

// ---------------------------------------------------------------------------
// 简易查询：支持子串与正则（用于搜索框与分组着色）
// ---------------------------------------------------------------------------
class SimpleQuery {
  constructor(text) {
    this.text = text;
    const trimmed = text.trim();
    this.regex = null;
    if (/^\/.+\/$/.test(trimmed)) {
      try { this.regex = new RegExp(trimmed.slice(1, -1), "i"); } catch (e) { /* ignore */ }
    }
    this.lower = trimmed.toLowerCase();
  }
  matchFilepath(path) {
    if (this.regex) return this.regex.test(path);
    if (!this.lower) return true;
    return path.toLowerCase().includes(this.lower);
  }
  matchTag(tag) {
    if (this.regex) return this.regex.test(tag);
    if (!this.lower) return true;
    const t = tag.toLowerCase().replace(/^#/, "");
    return t.includes(this.lower.replace(/^#/, ""));
  }
}

// 导出（浏览器 + 测试双端）
if (typeof module !== "undefined") module.exports = { GraphDataBuilder, SimpleQuery, DEFAULT_OPTIONS };
if (typeof self !== "undefined" && typeof module === "undefined") self.GraphData = { GraphDataBuilder, SimpleQuery, DEFAULT_OPTIONS };
