import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createCourseLinkResolver, resolveCourseLink } from '@deepseek-ai/dsh-util-course-document'
import { defaultCourseGraphSettings } from '../src/client/course/graph-settings.ts'
import { isCourseGraphLayout } from '../src/client/course/graph-layout.ts'

const engine = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../../../apps/web/public/course-graph/' + file), 'utf8')
const view = (program: string): unknown =>
  runInNewContext(engine('graph-view.js') + '\n' + program, {
    matchMedia: () => ({ matches: true }),
    window: { devicePixelRatio: 1 },
  })

it('accepts only finite layout hints for files whitelisted by the current course', () => {
  const paths = new Set(['A.md'])
  expect(
    isCourseGraphLayout(
      { positions: [{ path: 'A.md', x: 1, y: 2 }], view: { scale: 0.5, centerX: 0, centerY: 0 } },
      paths,
    ),
  ).toBe(true)
  expect(isCourseGraphLayout({ positions: [{ path: '../other/A.md', x: 1, y: 2 }] }, paths)).toBe(false)
  expect(isCourseGraphLayout({ positions: [{ path: 'A.md', x: Infinity, y: 2 }] }, paths)).toBe(false)
  expect(isCourseGraphLayout({ positions: [], view: { scale: 0, centerX: 0, centerY: 0 } }, paths)).toBe(false)
})

it('restores saved coordinates before the first layout message', () => {
  expect(
    view(`
    const messages=[],graph=Object.create(GraphView.prototype);
    Object.assign(graph,{nodes:[],links:[],nodeLookup:{},layoutEpoch:0,worker:{postMessage:m=>messages.push(m)},changed:()=>{}});
    graph.setData({nodes:{A:{type:'',links:{B:true}},B:{type:'',links:{}}}},{A:[123,456],B:[789,123]});
    ({coordinates:messages[0].nodes,A:[graph.nodeLookup.A.x,graph.nodeLookup.A.y]});
  `),
  ).toEqual({ coordinates: { A: [123, 456], B: [789, 123] }, A: [123, 456] })
})

it('retains exact link ambiguity and relative priority with indexed lookup', () => {
  const paths = ['A.md', 'other/A.md', 'folder/B.md', 'folder/B', 'folder/C.md', 'root.png', 'folder/space name.md']
  const indexed = createCourseLinkResolver(paths)
  for (const from of paths)
    for (const target of [
      '',
      'A',
      'B',
      'C',
      '../A',
      '../../A',
      'folder/C',
      '/A',
      'root.png',
      'space%20name',
      '%ZZ',
      'https://example.com/A',
      'other\\A',
      'missing',
    ])
      for (const wiki of [true, false])
        expect(indexed(from, target, wiki)).toEqual(resolveCourseLink(from, target, paths, wiki))
})

it('does not reheat physics for appearance-only data and removes many edges in one pass', () => {
  expect(
    view(`
    const messages = [], graph = Object.create(GraphView.prototype);
    Object.assign(graph, {nodes:[],links:[],nodeLookup:{},layoutEpoch:0,worker:{postMessage:m=>messages.push(m)},changed:()=>{}});
    const nodes = {};
    for(let i=0;i<100;i++)nodes['file/'+i+'.md']={type:'',links:{}};
    for(let i=0;i<100;i++)for(let j=0;j<100;j++)if(i!==j)nodes['file/'+i+'.md'].links['file/'+j+'.md']=true;
    graph.setData({nodes});
    graph.setData({nodes:Object.fromEntries(Object.entries(nodes).map(([id,node])=>[id,{...node,color:'#fff'}]))});
    graph.setFocusedNode('file/0.md');
    const afterAppearance = messages.length;
    graph.setData({nodes:{'file/0.md':{type:'',links:{}}}});
    ({afterAppearance,total:messages.length,nodes:graph.nodes.length,edges:graph.links.length,
      retainedPosition:messages[1].nodes['file/0.md']});
  `),
  ).toMatchObject({ afterAppearance: 1, total: 2, nodes: 1, edges: 0, retainedPosition: false })
})

it('culls offscreen objects and retains edges crossing the viewport', () => {
  expect(
    view(`
    const graph = Object.create(GraphView.prototype);
    Object.assign(graph,{nodes:[],nodeLookup:{},viewport:{left:0,right:100,top:0,bottom:100},
      fNodeSizeMult:1,fLineSizeMult:.1,fShowArrow:false,scale:1,nodeScale:1,dpr:1,dtScale:1,textAlpha:0,
      colors:{fill:{r:1,g:1,b:1,a:1},line:{r:1,g:1,b:1,a:1},text:{a:1},arrow:{a:1}},getHighlightNode:()=>null});
    const a=new KGNode(graph,'a',''),b=new KGNode(graph,'b','');
    a.x=-1000;a.y=50;b.x=1000;b.y=50;
    const nodes=[],labels=[],rings=[],links=[],arrows=[];
    a.renderFrame(null,1,nodes,labels,rings);
    new KGLink(graph,a,b).renderFrame(null,1,links,arrows);
    a.y=b.y=-1000;
    new KGLink(graph,a,b).renderFrame(null,1,links,arrows);
    ({nodes:nodes.length,labels:labels.length,links:links.length});
  `),
  ).toEqual({ nodes: 0, labels: 0, links: 1 })
})

it('accepts the first complete shared snapshot and rejects an in-progress write', () => {
  expect(
    view(`
    const buffer=new SharedArrayBuffer(12),positions=new Float32Array(buffer,0,2),version=new Int32Array(buffer,8,1);
    positions.set([12,34]);Atomics.store(version,0,2);
    const graph=Object.create(GraphView.prototype),node={fx:null,fy:null};
    Object.assign(graph,{layoutEpoch:1,positionVersion:-1,positionSnapshot:new Float32Array(2),nodeLookup:{A:node},
      workerLayout:{id:['A'],buffer},workerResults:{epoch:1,v:2},opts:{}});
    graph.applyPositions();const first=[node.x,node.y];
    Atomics.store(version,0,3);positions.set([90,90]);graph.applyPositions();
    const during=[node.x,node.y];Atomics.store(version,0,4);graph.applyPositions();
    ({first,during,after:[node.x,node.y]});
  `),
  ).toEqual({ first: [12, 34], during: [12, 34], after: [90, 90] })
})

it('bounds transferable frames, sends IDs once and flushes the final pending position on recycle', () => {
  const messages: { type: string; epoch: number; buffer?: ArrayBuffer; id?: string[] }[] = []
  const jobs: (() => void)[] = []
  const context = {
    importScripts: () => {},
    self: { crossOriginIsolated: false, onmessage: (_event: { data: object }) => {} },
    postMessage: (message: (typeof messages)[number]) => messages.push(message),
    setTimeout: (callback: () => void) => {
      jobs.push(callback)
      return jobs.length
    },
    clearTimeout: () => {},
  }
  runInNewContext(engine('sim-worker.js'), context)
  context.self.onmessage({ data: { nodes: { A: [10, 10], B: [500, 10] }, epoch: 1, run: true } })
  for (let i = 0; jobs.length > 0 && i < 400; i++) jobs.shift()?.()
  expect(messages.filter(message => message.type === 'layout')).toHaveLength(1)
  expect(messages.filter(message => message.type === 'positions')).toHaveLength(2)
  expect(messages.filter(message => message.id !== undefined)).toHaveLength(1)
  const frame = messages.find(message => message.type === 'positions')
  context.self.onmessage({ data: { recycle: frame?.buffer, epoch: 1 } })
  expect(messages.filter(message => message.type === 'positions')).toHaveLength(3)
  const last = messages.at(-1)
  expect(last?.epoch).toBe(1)
})

it('uses Barnes–Hut aggregate forces with bounded error and stops when empty', () => {
  const output: unknown = runInNewContext(
    engine('sim-worker.js') +
      `
    nodes=Array.from({length:400},(_,i)=>({x:(i%20)*400,y:Math.floor(i/20)*400,vx:0,vy:0}));
    applyRepulsion(1);
    let error=0,total=0;
    for(const n of nodes){
      let x=0,y=0;
      for(const other of nodes){if(other===n)continue;const dx=other.x-n.x,dy=other.y-n.y,d=dx*dx+dy*dy;x-=1000*dx/d;y-=1000*dy/d;}
      error+=Math.hypot(n.vx-x,n.vy-y);total+=Math.hypot(x,y);
    }
    error/total;
  `,
    { self: {}, setTimeout: () => 1, clearTimeout: () => {} },
  )
  expect(output).toBeLessThan(0.06)
  const visits: unknown = runInNewContext(
    'let visits=0;\n' +
      engine('sim-worker.js').replace('if (q.mass === 0) return;', 'visits++; if (q.mass === 0) return;') +
      `
      nodes=Array.from({length:400},(_,i)=>({x:(i%20)*400,y:Math.floor(i/20)*400,vx:0,vy:0}));
      applyRepulsion(1);visits;
    `,
    { self: {}, setTimeout: () => 1, clearTimeout: () => {} },
  )
  expect(visits).toBeLessThan((400 * 400) / 2)
})

it('coalesces filters, avoids appearance rebuilds and cancels pending work when the view closes', () => {
  const listeners = new Map<string, (event: { source: object; origin: string; data: object }) => void>()
  const jobs = new Map<number, () => void>()
  let sequence = 0,
    builds = 0,
    destroyed = false
  const parent = { postMessage: () => {} }
  const element = { style: { setProperty: () => {} }, addEventListener: () => {} }
  const context = {
    location: { hash: '#channel', origin: 'https://studio.test' },
    parent,
    self: {},
    console,
    document: { getElementById: () => element, documentElement: element, body: element },
    window: {
      addEventListener: (name: string, fn: typeof listeners extends Map<string, infer F> ? F : never) =>
        listeners.set(name, fn),
    },
    setTimeout: (fn: () => void) => {
      jobs.set(++sequence, fn)
      return sequence
    },
    clearTimeout: (id: number) => jobs.delete(id),
    setInterval: () => 1,
    clearInterval: () => {},
    GraphView: class {
      glCanvas = element
      worker = null
      setData() {
        builds++
      }
      setFocusedNode() {}
      setRenderOptions() {}
      setForces() {}
      refreshTheme() {}
      onResize() {}
      destroy() {
        destroyed = true
      }
    },
  }
  runInNewContext(engine('graph-data.js') + '\n' + engine('bridge.js'), context)
  const send = (data: object): void =>
    listeners.get('message')?.({
      source: parent,
      origin: context.location.origin,
      data: { protocol: 'studio-course-graph-v1', channel: 'channel', ...data },
    })
  const settings = { ...defaultCourseGraphSettings }
  send({
    type: 'update',
    revision: 1,
    notes: [{ path: 'A.md', links: [], tags: [] }],
    settings,
    currentPath: 'A.md',
    animationRevision: 0,
  })
  expect(builds).toBe(1)
  send({ type: 'update', revision: 1, settings: { ...settings, lineSizeMultiplier: 0.2 }, animationRevision: 0 })
  expect(builds).toBe(1)
  for (const search of ['A', 'AB', 'ABC'])
    send({ type: 'update', revision: 1, settings: { ...settings, search }, animationRevision: 0 })
  expect(jobs.size).toBe(1)
  for (const [id, fn] of jobs) {
    jobs.delete(id)
    fn()
  }
  expect(builds).toBe(2)
  send({ type: 'update', revision: 1, settings, animationRevision: 0 })
  expect(jobs.size).toBe(1)
  send({ type: 'dispose' })
  expect(destroyed).toBe(true)
  expect(jobs.size).toBe(0)
})
