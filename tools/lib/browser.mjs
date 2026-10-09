import { chromium as playwright } from '@playwright/test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
export async function launchBrowser() {
 let options={args:[]};
 if (process.env.HUD_CHROMIUM_PATH) options.executablePath=process.env.HUD_CHROMIUM_PATH;
 else {
  try {
   const { default: chromium, inflate } = await import('@sparticuz/chromium');
   const require=createRequire(import.meta.url);
   const packageRoot=dirname(dirname(require.resolve('@sparticuz/chromium')));
   await inflate(join(packageRoot,'bin','al2023.tar.br'));
   options={executablePath:await chromium.executablePath(),env:{...process.env,LD_LIBRARY_PATH:[join(tmpdir(),'al2023','lib'),tmpdir(),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')},args:chromium.args.filter(a=>!a.startsWith('--disable-gpu')&&!a.startsWith('--single-process'))};
  } catch {}
 }
 options.args.push('--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--disable-dev-shm-usage');
 return playwright.launch(options);
}
