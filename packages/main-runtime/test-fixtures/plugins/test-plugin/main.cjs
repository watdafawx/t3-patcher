'use strict';
// WP-2 test plugin (main entry). Exercises ctx.ipc, ctx.log, ctx.native (fs.read) and ctx.patches.

exports.activate = function activate(ctx) {
  ctx.log.info('test-plugin activating');
  ctx.ipc.handle('echo', (payload) => ({ echo: payload, from: ctx.id, native: ctx.native ? Object.keys(ctx.native).sort() : [], patches: !!ctx.patches }));
  ctx.ipc.handle('read', (payload) => {
    if (!ctx.native || !ctx.native.fsRead) throw new Error('fs.read not granted');
    return ctx.native.fsRead(payload);
  });
  ctx.ipc.handle('boom', () => {
    throw new Error('handler exploded');
  });
};
