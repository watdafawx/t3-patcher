// In-page probe for tools/rig/perf/bg-perf.mjs. Evaluated in the T3 Code page; installs window.__t3pPerf.
//   __t3pPerf.start({ workload: true|false })  -> begins recording (and the synthetic chat workload)
//   __t3pPerf.stop()                          -> returns raw samples, removes the workload DOM
// The workload mimics what the user feels: a chat-like column inside the app's main area that streams tokens
// (append every 30 ms, new paragraph / code block now and then, auto-scrolls to the bottom), a textarea that
// receives CDP key events, and the same container receiving CDP wheel events. Nothing is sent to the server.
(() => {
  if (window.__t3pPerf) return "already";
  // Rig's desktop may lose focus to other windows (remote tools). The backgrounds pause 5 s after a window blur, which
  // would silently measure a paused layer, so swallow blur while the probe is installed (capture runs first at target).
  window.addEventListener("blur", (e) => e.stopImmediatePropagation(), true);
  const state = { on: false };
  const WORDS = "the quick brown fox jumps over a lazy dog while streaming markdown tokens arrive from the model and the renderer keeps up".split(" ");

  function mountWorkload() {
    const host = document.querySelector('[data-slot="sidebar-inset"]') || document.body;
    const box = document.createElement("div");
    box.id = "t3p-perf-stream";
    // Transparent like the real chat column (markSurfaces makes the app wrappers see-through).
    box.style.cssText = "position:absolute;left:8%;right:8%;top:56px;bottom:120px;overflow:auto;z-index:50;color:var(--foreground);font:14px/1.6 system-ui,sans-serif;padding:16px";
    const ta = document.createElement("textarea");
    ta.id = "t3p-perf-input";
    ta.style.cssText = "position:absolute;left:8%;right:8%;bottom:24px;height:80px;z-index:51;background:var(--card,Canvas);color:var(--foreground);border:1px solid var(--border,gray);border-radius:12px;padding:8px";
    host.appendChild(box);
    host.appendChild(ta);
    for (let i = 0; i < 120; i++) {
      const p = document.createElement("p");
      p.textContent = Array.from({ length: 40 }, (_, k) => WORDS[(i * 7 + k) % WORDS.length]).join(" ");
      box.appendChild(p);
    }
    box.scrollTop = box.scrollHeight;
    ta.focus();
    return { box, ta };
  }

  window.__t3pPerf = {
    start(opts = {}) {
      if (state.on) this.stop();
      const s = {
        t0: performance.now(),
        frames: [],
        loaf: [],
        events: [],
        keys: [],
        appends: [],
        pendingAppends: [],
        pendingKeys: [],
        draws0: Array.isArray(window.__t3pBgPerf) ? window.__t3pBgPerf.length : 0,
        focus: document.hasFocus(),
        vw: innerWidth,
        vh: innerHeight,
        dpr: devicePixelRatio,
      };
      Object.assign(state, s, { on: true });
      let last = 0;
      const raf = (ts) => {
        if (!state.on) return;
        if (last) state.frames.push(ts - last);
        last = ts;
        const now = performance.now();
        for (const a of state.pendingAppends) state.appends.push(now - a);
        state.pendingAppends.length = 0;
        for (const k of state.pendingKeys) state.keys.push({ delay: k.delay, toFrame: now - k.ts });
        state.pendingKeys.length = 0;
        state.raf = requestAnimationFrame(raf);
      };
      state.raf = requestAnimationFrame(raf);
      try {
        state.obsL = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) state.loaf.push({ d: e.duration, b: e.blockingDuration ?? 0, r: e.renderStart ? e.startTime + e.duration - e.renderStart : 0 });
        });
        state.obsL.observe({ type: "long-animation-frame", buffered: false });
      } catch {
        // long-animation-frame not supported: no LoAF numbers
      }
      try {
        state.obsE = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) state.events.push({ n: e.name, d: e.duration, delay: e.processingStart - e.startTime });
        });
        state.obsE.observe({ type: "event", durationThreshold: 16, buffered: false });
      } catch {
        // Event Timing not supported: no event numbers
      }
      if (opts.workload) {
        const { box, ta } = mountWorkload();
        state.box = box;
        state.ta = ta;
        state.onKey = (e) => state.pendingKeys.push({ ts: e.timeStamp, delay: performance.now() - e.timeStamp });
        ta.addEventListener("keydown", state.onKey);
        let para = null;
        let n = 0;
        state.stream = setInterval(() => {
          const at = performance.now();
          if (!para || n % 40 === 0) {
            if (n % 200 === 0) {
              para = document.createElement("pre");
              para.style.cssText = "background:var(--muted,rgba(127,127,127,.1));padding:8px;border-radius:8px";
            } else para = document.createElement("p");
            box.appendChild(para);
          }
          para.textContent += WORDS[n % WORDS.length] + " ";
          n++;
          if (box.children.length > 400) box.firstElementChild.remove();
          box.scrollTop = box.scrollHeight;
          state.pendingAppends.push(at);
        }, 30);
      }
      return { focus: state.focus, vw: state.vw, vh: state.vh, dpr: state.dpr };
    },
    /** Center of the stream box in CSS px (for CDP wheel events). */
    boxCenter() {
      const r = (state.box || document.body).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    stop() {
      if (!state.on) return null;
      state.on = false;
      cancelAnimationFrame(state.raf);
      state.obsL?.disconnect();
      state.obsE?.disconnect();
      clearInterval(state.stream);
      state.ta?.removeEventListener("keydown", state.onKey);
      state.box?.remove();
      state.ta?.remove();
      const out = {
        ms: performance.now() - state.t0,
        frames: state.frames,
        loaf: state.loaf,
        events: state.events,
        keys: state.keys,
        appends: state.appends,
        focus: state.focus && document.hasFocus(),
        bgDraws: (Array.isArray(window.__t3pBgPerf) ? window.__t3pBgPerf.length : 0) - state.draws0,
        vw: state.vw,
        vh: state.vh,
        dpr: state.dpr,
      };
      state.box = state.ta = null;
      return out;
    },
  };
  return "installed";
})()
