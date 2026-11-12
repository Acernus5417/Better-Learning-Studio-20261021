/* Connect the supplied graph engine to one parent-owned, course-scoped channel. */
(() => {
  'use strict';
  const channel = location.hash.slice(1), origin = location.origin, target = origin === 'null' ? '*' : origin;
  const container = document.getElementById('graph');
  let view, records = [], settings, timer, updateTimer, layoutTimer, layout, initialPositions, restored = false, progression = 0, lastAnimation = -1, revision = -1, graphSpec = '', forceSpec = '', renderSpec = '', interacted = false, disposed = false;
  const send = (type, data = {}) => parent.postMessage({protocol:'studio-course-graph-v1',channel,type,...data},target);
  const stop = () => { if(timer !== undefined) clearInterval(timer); timer = undefined; progression = 0; };
  const builder = new GraphDataBuilder();
  const prefix = path => 'file/' + path;
  const saveLayout = () => {
    clearTimeout(layoutTimer);layoutTimer=undefined;
    if(!view || disposed || !view.nodes?.length || progression)return;
    const positions=view.nodes.filter(node=>node.id.startsWith('file/')&&Number.isFinite(node.x)&&Number.isFinite(node.y)).map(node=>({path:node.id.slice(5),x:node.x,y:node.y}));
    if(!positions.length)return;
    send('layout',{layout:{positions,view:{scale:view.scale,centerX:(view.width*view.dpr/2-view.panX)/view.scale,centerY:(view.height*view.dpr/2-view.panY)/view.scale}}});
  };
  const queueLayout = () => { if(layoutTimer===undefined)layoutTimer=setTimeout(saveLayout,1500); };
  const dispose = () => { if(disposed)return;saveLayout(); disposed = true; stop(); clearTimeout(updateTimer);clearTimeout(layoutTimer); if(view)view.destroy(); view=undefined; };
  const fail = error => { console.error('course graph:',error); dispose(); send('error'); };
  const query = text => {
    const simple = new SimpleQuery(text.replace(/^(?:path:|file:)/i,''));
    const tag = /^tag:|^#/i.test(text);
    const tagQuery = new SimpleQuery(text.replace(/^tag:/i,''));
    return { matchFilepath: path => tag ? (builder.notes.get(path)?.tags || []).some(value=>tagQuery.matchTag(value)) : simple.matchFilepath(path.replace(/^file\//,'')), matchTag: value => tagQuery.matchTag(value) };
  };
  const draw = () => {
    if(!view || !settings)return;
    const searches = settings.search.split(/[,，]/).map(text=>text.trim()).filter(Boolean).map(text=>({query:query(text),color:null}));
    // Search filters always run before color groups, so a color match cannot bypass the filter.
    searches.push(...settings.groups.filter(group=>group.query.trim()).map(group=>({query:query(group.query),color:group.color})));
    const graph = builder.build({showAttachments:settings.showAttachments,showTags:settings.showTags,hideUnresolved:settings.hideUnresolved,
      showOrphans:settings.showOrphans,searchQueries:searches,progression,
      localFile:settings.local && settings.currentPath ? prefix(settings.currentPath) : null,
      localJumps:settings.localJumps,localForelinks:settings.localForelinks,localBacklinks:settings.localBacklinks,localInterlinks:settings.localInterlinks});
    if(Object.keys(graph.nodes).length>5000)throw new Error('Course graph node limit exceeded');
    view.setData(graph,initialPositions);
    if(!restored && layout?.view && layout.positions?.length){
      const camera=layout.view;
      view.setScale(camera.scale);view.targetScale=camera.scale;
      view.setPan(view.width*view.dpr/2-camera.centerX*camera.scale,view.height*view.dpr/2-camera.centerY*camera.scale);
      interacted=true;restored=true;view.changed();
    }
    view.focusedId = undefined;
    view.setFocusedNode(prefix(settings.currentPath));
    let edges=0;for(const node of Object.values(graph.nodes))edges+=Object.keys(node.links).length;
    send('stats',{nodes:Object.keys(graph.nodes).length,edges});
  };
  const animate = () => {
    stop(); progression = 1;
    const total = records.reduce((sum,note)=>sum+1+note.links.length+(settings.showTags?note.tags.length:0),0);
    const step = Math.max(5,Math.min(100,Math.sqrt(total)*.5));
    draw();
    timer=setInterval(()=>{ progression+=Math.ceil(step);if(progression>=total){stop();draw();send('stopped');}else draw(); },120);
  };
  try {
    view = new GraphView(container,{workerUrl:'sim-worker.js',workerFactory:()=>self.createSimWorkerProxy(),onIdle:saveLayout,onPositions:positions=>{
      queueLayout();
      if(interacted || !view)return;
      let x=60,y=60;for(let i=0;i<positions.length;i+=2){x=Math.max(x,Math.abs(positions[i])+60);y=Math.max(y,Math.abs(positions[i+1])+60);}
      const scale=Math.min(1,Math.max(.02,Math.min((view.width-32)*view.dpr/(x*2),(view.height-32)*view.dpr/(y*2))));
      if(Math.abs(Math.log(view.targetScale/scale))>.02)view.zoomTo(scale);
    },onNodeClick:(id,type)=>{
      if(id.startsWith('file/') && type!=='unresolved')send('open',{path:id.slice(5)});
    }});
    container.tabIndex=0;view.glCanvas.tabIndex=0;
    for(const type of ['pointerdown','wheel','keydown'])container.addEventListener(type,()=>{interacted=true;queueLayout();},{passive:true});
    view.glCanvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(!disposed)fail(new Error('WebGL context lost'));});
    if(view.worker){
      view.worker.onerror=fail;
    }
    view.onResize();
  } catch(error){fail(error);}
  window.addEventListener('message',event=>{
    if(event.source!==parent || event.origin!==origin || !event.data || event.data.protocol!=='studio-course-graph-v1' || event.data.channel!==channel)return;
    const message=event.data;
    if(message.type==='hello'){send(view&&!disposed?'ready':'error');return;}
    if(message.type==='dispose'){dispose();return;}
    if(message.type!=='update' || !view || disposed)return;
    try {
      if(!Number.isSafeInteger(message.revision) || !message.settings || !Array.isArray(message.settings.groups))throw new Error('Invalid graph input');
      settings={...message.settings,currentPath:message.currentPath};
      if(typeof message.background==='string'){
        document.documentElement.style.backgroundColor=message.background;
        document.body.style.backgroundColor=message.background;
        container.style.backgroundColor=message.background;
      }
      for(const [name,color] of Object.entries(message.colors||{}))if(/^--kgv-color-[a-z-]+$/.test(name) && typeof color==='string')container.style.setProperty(name,color);
      if(settings.highlightColor)container.style.setProperty('--kgv-color-fill-highlight',settings.highlightColor);
      if(message.colors || message.background)view.refreshTheme();
      const dataChanged=message.revision!==revision;
      if(dataChanged){
        if(!Array.isArray(message.notes) || message.notes.length>5000)throw new Error('Missing graph metadata');
        revision=message.revision; interacted=false; stop();
        if(!restored && message.layout){
          layout=message.layout;
          initialPositions=Object.fromEntries((layout.positions||[]).map(point=>[prefix(point.path),[point.x,point.y]]));
        }
        records=message.notes.map(note=>({...note,path:prefix(note.path),links:note.links.map(link=>({target:link.resolved?prefix(link.target):'missing/'+link.target,resolved:link.resolved}))}));
        builder.setNotes(records);
      }
      const nextRender=JSON.stringify([settings.nodeSizeMultiplier,settings.lineSizeMultiplier,settings.textFadeMultiplier,settings.showArrow,settings.highlightColor]);
      if(nextRender!==renderSpec){renderSpec=nextRender;view.setRenderOptions(settings);view.refreshTheme();}
      const forces={centerStrength:settings.centerStrength,repelStrength:settings.repelStrength**3,linkStrength:settings.linkStrength,linkDistance:settings.linkDistance};
      const nextForces=JSON.stringify(forces);
      if(nextForces!==forceSpec){forceSpec=nextForces;view.setForces(forces);}
      const nextGraph=JSON.stringify([settings.search,settings.groups,settings.showTags,settings.showAttachments,settings.hideUnresolved,settings.showOrphans,settings.local,settings.local?settings.currentPath:null,settings.localJumps,settings.localForelinks,settings.localBacklinks,settings.localInterlinks]);
      const topologyChanged=dataChanged || graphSpec!==nextGraph;
      graphSpec=nextGraph;
      const animationChanged=lastAnimation!==message.animationRevision;
      if(animationChanged){
        lastAnimation=message.animationRevision;clearTimeout(updateTimer);
        if(message.playing){animate();return;}else stop();
      }
      if(topologyChanged || animationChanged){
        clearTimeout(updateTimer);
        if(dataChanged)draw();
        else updateTimer=setTimeout(()=>{try{draw();}catch(error){fail(error);}},250);
      }else view.setFocusedNode(prefix(settings.currentPath));
    }catch(error){fail(error);}
  });
  window.addEventListener('pagehide',dispose,{once:true});
  window.addEventListener('blur',()=>{ if(view)view.keyboardActions={}; });
  window.addEventListener('error',fail);
  if(view)send('ready');
})();
