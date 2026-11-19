'use strict';
// WP-5B rig-only probe. Reproduces electron-updater's NsisUpdater.quitAndInstall(silent, forceRun) exactly:
//   spawn the NSIS installer detached with --updated /S --force-run [/D=dir], then
//   require('electron').autoUpdater.emit('before-quit-for-update'), then app.quit().
// The real in-app updater cannot be used on rig: upstream has no stable release newer than the installed one.
const { spawn } = require('node:child_process');

exports.activate = function activate(ctx) {
  ctx.ipc.handle('info', () => ({ pid: process.pid, execPath: process.execPath, version: process.versions.electron }));
  ctx.ipc.handle('update', ({ installerParts, dirParts, emit = true, forceRun = false }) => {
    // Paths come in as segment arrays and are joined with backslashes here: NSIS /D needs real backslashes
    // and every shell/CDP layer in between eats them.
    const installer = installerParts.join(String.fromCharCode(92));
    const dir = dirParts && dirParts.join(String.fromCharCode(92));
    const args = ['--updated', '/S'];
    // --force-run relaunches the app WITHOUT the slot env (real APPDATA / T3P_HOME on rig): off by default.
    if (forceRun) args.push('--force-run');
    if (dir) args.push('/D=' + dir); // NSIS: /D must be last, unquoted
    const child = spawn(installer, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setImmediate(() => {
      const electron = require('electron');
      if (emit) electron.autoUpdater.emit('before-quit-for-update');
      electron.app.quit();
    });
    return { spawned: child.pid, args };
  });
};
