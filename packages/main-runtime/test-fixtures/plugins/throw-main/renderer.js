// Must never load: its main entry fails, so the host drops the renderer entry too.
window.__t3p_throw_main_renderer_loaded = true;
export function start() {}
