import { launchBrowser } from './lib/browser.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const arg=(name,def)=>{const i=process.argv.indexOf(name);return i<0?def:process.argv[i+1]};
const out=arg('--out','docs/upgrade/after'),url=arg('--url','http://127.0.0.1:4174/');mkdirSync(out,{recursive:true});
const browser=await launchBrowser(),page=await browser.newPage({viewport:{width:412,height:915},locale:'fa-IR'});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(url+'?quality=low');await page.waitForFunction(()=>window.__NUR__&&!document.querySelector('.ui-loading'),null,{timeout:120000});
await page.evaluate(async()=>{await window.__NUR__.ensureAll();window.__NUR__.metaSystem.skipTutorial();window.__NUR__.ftueGuide.dispose();});
const result=await page.evaluate(async()=>{
 const n=window.__NUR__,r=n.engine.renderer; n.engine.pause('audit');n.world.setReducedMotion(true);
 const snapshot=()=>{n.buildingView.beforeRender();r.render(n.engine.scene,n.engine.camera);return {...r.info.memory,programs:r.info.programs.length}};
 const cycles=[];
 for(let i=0;i<10;i++){
  n.battlePanel.show();n.battlePanel.hide();n.barracksPanel.show();n.barracksPanel.hide();n.settingsPanel.show();n.settingsPanel.close();
  n.game.battle.start({encounterId:'raid-column',seed:33});const sim=n.game.battle.sim;sim.tick();n.battleView.mount(sim);n.battleView.update(.05);snapshot();n.battleView.unmount();n.game.battle.withdraw();n.game.battle.closeSession();cycles.push(snapshot());
 }
 n.engine.setRuntimeSettings({qualityTier:'medium',batterySaver:false});n.world.setReducedMotion(false);n.world.update(.1,n.engine);n.world.beforeRender(n.engine);await n.world.shadowPromise;
 const shadow=[];
 for(const dt of [.1,.1,1.6]){n.world.update(dt,n.engine);n.world.beforeRender(n.engine);const light=n.world.lights.sun,globalDirty=r.shadowMap.needsUpdate,lightDirty=light.shadow.needsUpdate,before=light.shadow.matrix.elements.slice();r.render(n.engine.scene,n.engine.camera);shadow.push({dt,globalDirty,lightDirty,matrixChange:before.some((x,i)=>x!==light.shadow.matrix.elements[i]),bounds:{left:light.shadow.camera.left,right:light.shadow.camera.right,near:light.shadow.camera.near,far:light.shadow.camera.far}})}
 n.dispose();return{cycles,shadow,terminal:{...r.info.memory,programs:r.info.programs.length}};
});
result.errors=errors;writeFileSync(out+'/lifecycle.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();
