'use strict';
// Registers a handler, then throws: the host must remove the handler and mark the plugin failed.
exports.activate = function activate(ctx) {
  ctx.ipc.handle('ghost', () => 'should not stay registered');
  throw new Error('throw-main: activate exploded on purpose');
};
