/* eslint-disable no-empty -- plain CommonJS, embedded verbatim into the replacement app.asar */
'use strict';
// T3 Patcher shim. Fail-open: any error is logged and the stock app still starts. Never touches userData.
const fs = require('fs'), path = require('path'), os = require('os');
const H = path.join(process.env.T3P_HOME || os.homedir(), '.t3-patcher');
function log(m) { try { const d = path.join(H, 'logs'); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, 'shim.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} }
try {
  let safe = process.env.T3P_SAFE === '1' || process.argv.includes('--t3p-safe');
  const mark = path.join(H, 'safe-mode');
  if (fs.existsSync(mark)) { safe = true; fs.rmSync(mark, { force: true }); }
  const rt = path.join(H, 'runtime', 'main.cjs');
  if (safe) log('safe mode: runtime not loaded');
  else if (fs.existsSync(rt)) require(rt);
  else log('runtime missing: ' + rt + ' (stock app)');
} catch (e) { log('runtime failed (fail-open): ' + (e && e.stack || e)); }
require(path.join(process.resourcesPath, '_app.asar'));
