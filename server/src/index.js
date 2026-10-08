#!/usr/bin/env node
/**
 * «شهر نور» — multiplayer reference server (phase 8: جماعت).
 *
 *   node server/src/index.js [--port=8081] [--save=server/data/server.json]
 *
 * Zero dependencies: only Node.js built-ins (http, crypto, fs, net).
 */
import { resolve } from 'node:path';
import { GameServer } from './server.js';

function parseArgs(argv) {
  const options = { port: 8081, save: 'server/data/server.json' };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length));
      if (Number.isInteger(port) && port > 0 && port < 65536) options.port = port;
    } else if (arg.startsWith('--save=')) {
      options.save = arg.slice('--save='.length);
    } else if (arg === '--no-save') {
      options.save = null;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  // eslint-disable-next-line no-console
  console.log('Usage: node server/src/index.js [--port=8081] [--save=server/data/server.json] [--no-save]');
  process.exit(0);
}

const server = new GameServer({
  port: options.port,
  saveFile: options.save ? resolve(process.cwd(), options.save) : null,
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  // eslint-disable-next-line no-console
  console.log(`\n[شهر نور] دریافت ${signal}؛ ذخیره و خاموش‌شدن…`);
  try {
    await server.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  const { port } = await server.start();
  // eslint-disable-next-line no-console
  console.log(`[شهر نور] سلامت سرور: http://127.0.0.1:${port}/health`);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('[شهر نور] شروع سرور ناموفق بود:', error?.message || error);
  process.exit(1);
}
