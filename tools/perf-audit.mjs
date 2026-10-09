import { launchBrowser } from './lib/browser.mjs';
import { sceneFixture as fixture } from './lib/perf-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
const args=process.argv.slice(2),arg=(n,d)=>args.includes(n)?args[args.indexOf(n)+1]:d;
const out=arg('--out','docs/upgrade/before'),url=arg('--url','http://127.0.0.1:4173/');
mkdirSync(`${out}/scene-shots`,{recursive:true});
const browser=await launchBrowser(),results=[];
for(const throttle of [1,4])for(const tier of ['low','medium','high'])for(const scenario of ['empty','city30','battle30']){
 const context=await browser.newContext({viewport:{width:412,height:915},deviceScaleFactor:1,locale:'fa-IR',hasTouch:true,isMobile:true});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${url}?quality=${tier}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__NUR__&&!document.querySelector('.ui-loading'),null,{timeout:120000});
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:throttle});
 const spec=await page.evaluate(fixture,{scenario,tier});
 await page.waitForTimeout(2000);
 await cdp.send('HeapProfiler.collectGarbage');
 const measured=await page.evaluate(async()=>{
  const n=window.__NUR__,r=n.engine.renderer,original=r.render,intervals=[],durations=[],counters=[];let last=0;
  r.render=function(...args){const now=performance.now();if(last)intervals.push(now-last);last=now;const start=performance.now();const result=original.apply(this,args);durations.push(performance.now()-start);counters.push({calls:r.info.render.calls,triangles:r.info.render.triangles,geometries:r.info.memory.geometries,textures:r.info.memory.textures});return result;};
  await new Promise(resolve=>setTimeout(resolve,6000));r.render=original;
  const sorted=[...intervals].sort((a,b)=>a-b),mean=intervals.reduce((s,x)=>s+x,0)/intervals.length,p99=sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*0.99)-1)];
  const peak=k=>Math.max(...counters.map(c=>c[k]));
  return {frames:intervals.length,intervalsMs:intervals,meanFrameMs:mean,p99FrameMs:p99,fpsMean:1000/mean,fpsP1:1000/p99,renderSubmissionMs:durations.reduce((s,x)=>s+x,0)/durations.length,calls:peak('calls'),triangles:peak('triangles'),geometries:peak('geometries'),textures:peak('textures'),quality:n.engine.runtimeQualityTier,dpr:n.engine.viewport.dpr,unitsEnd:n.game.battle.sim?.units.filter(u=>!u.removed).length||0};
 });
 await cdp.send('HeapProfiler.collectGarbage');await cdp.send('Performance.enable');const metrics=await cdp.send('Performance.getMetrics');measured.heapBytes=metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value??null;
 if(throttle===1){await page.evaluate(()=>{window.__NUR__.engine.pause('audit-shot');});await page.screenshot({path:`${out}/scene-shots/${scenario}-${tier}.png`});}
 const row={scenario,tier,cpuThrottle:throttle,...spec,...measured,errors};results.push(row);
 writeFileSync(`${out}/performance.json`,JSON.stringify({environment:{date:'2026-10-09',commit:arg('--commit',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()),browser:browser.version(),os:os.platform(),arch:os.arch(),cpus:os.cpus().length,cpuModel:os.cpus()[0]?.model,viewport:'412x915',dpr:1,backend:'Chromium ANGLE/SwiftShader software rendering; not a physical phone',warmupMs:2000,sampleMs:6000},results},null,2));
 console.log(`${scenario} ${tier} cpu${throttle}x: ${row.fpsMean.toFixed(2)} /p1 ${row.fpsP1.toFixed(2)} fps · ${row.meanFrameMs.toFixed(2)}ms · calls${row.calls} triangles${row.triangles} geom${row.geometries} tex${row.textures} heap${(row.heapBytes/1048576).toFixed(2)}MiB`);
 await context.close();
}
for(const viewport of [{width:360,height:640},{width:412,height:915},{width:844,height:390},{width:768,height:1024}]){
 const page=await browser.newPage({viewport,locale:'fa-IR'});await page.goto(`${url}?quality=medium`);await page.waitForFunction(()=>window.__NUR__&&!document.querySelector('.ui-loading'),null,{timeout:120000});await page.evaluate(()=>{window.__NUR__.metaSystem.skipTutorial();window.__NUR__.ftueGuide?.dispose();window.__NUR__.world.setReducedMotion(true);window.__NUR__.hud.toast('');});await page.screenshot({path:`${out}/hud-${viewport.width}x${viewport.height}.png`});await page.close();
}
await browser.close();
