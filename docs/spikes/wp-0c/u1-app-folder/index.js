// U1 probe: resources/app/ shim. If Electron loads this BEFORE app.asar, shim.log gets a line and stderr shows T3P-APPDIR-RAN.
const fs = require('fs');
const path = require('path');
const DIR = 'G:/rig-run/t3patcher/spike/wp0c-s3';
fs.mkdirSync(DIR, { recursive: true });
fs.appendFileSync(path.join(DIR, 'shim.log'), `${new Date().toISOString()} appdir-shim ran type=${process.type} argv=${JSON.stringify(process.argv)}\n`);
process.stderr.write('T3P-APPDIR-RAN\n');
// load the real app (entry of app.asar)
require(path.join(process.resourcesPath, process.env.T3P_REAL || 'app.asar'));
