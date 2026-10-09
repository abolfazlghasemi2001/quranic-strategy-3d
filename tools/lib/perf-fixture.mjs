export const sceneFixture=async({scenario,tier})=>{
 const n=window.__NUR__;
 if(n.ensureBattle)await n.ensureBattle();
 if(n.ensureGuide)await n.ensureGuide();
 n.metaSystem.skipTutorial();n.ftueGuide.dispose();n.buildings.clearSelection();n.hud.toast('');
 n.world.setGridVisible(false);n.world.setReducedMotion(false);
 for(const e of [...n.game.state.entities.values()]){n.bus.emit('game:building-removed',{entityId:e.id});n.game.state.entities.delete(e.id);}n.buildings.occupancy.clear();
 n.game.state.resources={rizq:1e5,nur:1e5,hekmat:1e5,gohar:100};n.game.state.jobs.length=0;
 const add=(type,col,row,level=1)=>{const d=n.buildings.byId.get(type);const e=n.game.state.createEntity({type,name:d.name,col,row,size:d.size,level,status:'ready',lastAccrualAt:Date.now(),pending:0});n.buildings._ensureHealth(e);n.buildings._occupy(e);n.bus.emit('game:building-added',{entity:e});return e;};
 if(scenario!=='empty'){
  add('town-center',19,19,2);
  const types=['farm','warehouse','light-spring','watchtower','barracks','library','dar-al-quran','sentry-post'];
  const cells=[];for(let row=3;row<36;row+=4)for(let col=3;col<36;col+=4)cells.push([col,row]);
  cells.sort((a,b)=>(a[0]-20)**2+(a[1]-20)**2-((b[0]-20)**2+(b[1]-20)**2));
  let i=0;for(const [col,row] of cells){if(n.game.state.entities.size>=30)break;const type=types[i++%types.length],d=n.buildings.byId.get(type);if(n.buildings.canPlace(d,col,row))add(type,col,row);}
  if(n.game.state.entities.size!==30)throw new Error(`fixture requires exactly 30 buildings, got ${n.game.state.entities.size}`);
 }
 n.rig.reset();n.rig.setDistance(88,{immediate:true});
 if(scenario==='battle30'){
  const started=n.game.battle.start({encounterId:'raid-siege',seed:20261007});if(!started.ok)throw new Error(started.reason);
  const sim=n.game.battle.sim;
  sim.spawnQueue=Array.from({length:30},(_,i)=>({tick:0,unit:['guard','archer','healer','breaker'][i%4],x:25+(i%10)*3,z:25+Math.floor(i/10)*3}));sim.spawnCursor=0;
  n.battleView.mount(sim); n.hud.setBattleLive(true);
  // Force all 30 into the measured window, then tick the real sim at 20 Hz.
  sim.tick();
  if(sim.units.length!==30)throw new Error(`requires 30 units, got ${sim.units.length}`);
 }
 n.buildingView.beforeRender?.(n.engine);
 if(n.buildingView.batches && n.buildingView.batches.renderedEntityIds.size!==n.game.state.entities.size)throw new Error('batch/state fixture mismatch');
 if(n.buildingView.roots.size!==n.game.state.entities.size)throw new Error('visual/state fixture mismatch');
 n.game.emitState(Date.now(),true);n.engine.setRuntimeSettings({qualityTier:tier,batterySaver:false});
 const gl=n.engine.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
 return {buildings:n.game.state.entities.size,units:n.game.battle.sim?.units.length||0,webgl:gl.getParameter(gl.VERSION),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unavailable'};
};
