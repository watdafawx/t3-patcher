# Artwork app backgrounds: performance (WP-13C)

With a full-app background on (Ocean, Antigravity, Gradient drift, Starfield) the whole app felt slow at 4K: typing, scrolling and streamed chat output stuttered, although our JavaScript draw cost was below 1 ms per frame. This page records how that was measured, what the cause was, what changed, and the raw numbers.

> **WP-17 update:** Antigravity was dropped and the lifecycle of every background was rewritten. See [WP-17](#wp-17-lifecycle-rewrite-and-the-antigravity-drop) at the end. The older sections keep their Antigravity numbers as history.

## Setup

- Rig slot 2 (stock T3 Code + patcher, Electron / Chrome 152), maximized on a 4K monitor at 175 % scale: viewport 2195x1187 CSS px, dpr 1.75, 120 Hz (vsync 8.3 ms). That matches a 4K desktop at 150-200 %.
- Driver: `tools/rig/perf/bg-perf.mjs` over CDP (see `tools/rig/README.md`). Per scenario: reset, apply the artwork settings, settle 2.5 s, then
  - **idle** window (5 s): nothing happens but the background;
  - **work** window (5 s): typing into a textarea (key every ~80 ms), wheel scrolling, and a fake streamed chat column appending a token every 30 ms inside the app's main pane (transparent, like the real chat).
- Metrics: rAF frame times and dropped frames (gap over 1.5 vsync), GPU process and renderer CPU % (`SystemInfo.getProcessInfo`), key delay (Event Timing) and key-to-next-frame p95, stream-append-to-frame lag p95, long animation frames, LayerTree layer count and memory. A separate traced window (`devtools.timeline`, `disabled-by-default-devtools.timeline.frame`, `gpu`, `cc`, `viz`) gives busy ms per second per thread; it is kept apart because tracing itself raises GPU CPU.
- Rig is shared (Minecraft servers, Docker, other slots), so absolute numbers move between runs: compare rows of one run. The "work drop/s" of ~40-45 even with the background off is the synthetic workload itself at 120 Hz on rig, not the background; the useful number is the difference to `off` in the same run.

## Root causes

1. **Producing canvas frames costs the GPU process, not our JavaScript.** Every frame a 2D canvas commits, the GPU process replays the stroke/fill stream and re-composites the full 4K window (the canvas sits under big transparent app layers). Antigravity at 60 fps: GPU process 79 % vs 25 % off, while its draw() took ~0.8 ms. A/B (same run):
   - canvas hidden (`display:none`) but still drawing: 70 % (so compositing the visible layer is not the main part; executing the canvas commands is);
   - app surfaces made opaque again (no transparency): 83 % (the `markSurfaces` transparency is not the cause);
   - speed 0 (one still frame): 32 % (cost disappears when frames stop);
   - 30 fps: 58 %; internal resolution 0.5x: 46 %; 1x: 83 % (same as shipped, which was already ~1x after the pixel budget); `will-change`: 82 % (no help).
   So the cost is fps x pixels x stroke work, paid in the GPU process, which then competes with the app's own frames: stream-to-frame p95 37 ms vs 31 ms off, work drops +20/s.
2. **Gradient drift (CSS) ran at the compositor's rate.** Four viewport-sized `transform` animations tick at 120 Hz with no JavaScript: 51 % GPU vs 31 % for the same layers still. "No JS" was not "cheap".
3. **Every preset animated while the user typed, scrolled or the chat streamed**, i.e. exactly when the app needs every frame.
4. Minor: the theme / surface poll read computed styles every second (forced style flush), also during typing.

Not the cause: `markSurfaces` transparency, layer promotion hints, the 115 MB of extra layer memory by itself (a still frame with the same layers costs about as much as off).

## What changed

- **Quality tiers** (`src/bg-perf.ts`, setting **Background quality** `bgQuality`: auto / high / balanced / low / static, default auto): per preset a frame rate and an internal resolution (px per CSS px, plus a pixel budget). Balanced is at most 30 fps everywhere (Antigravity 30 fps at 0.75x and 1.5 MP; Ocean/Starfield 20 fps; drift 20 fps).
- **Auto governor** (`QualityGovernor`): every 3 s looks at the average draw cost (> 4 ms), the share of our frames that came after a main-thread stall (rAF gap > 50 ms, > 25 %), and the page's long-animation-frame blocking time (> 150 ms, counted only while the background animates). Any over the limit: one tier down (balanced -> low -> static). Five clean windows: one tier back up, never above balanced.
- **Pause while typing** (`bgPauseWhileTyping`, default on; `ActivityGate` + `ActivityMonitor`): key, wheel or scroll, or a DOM mutation burst (>= 12 records per second: streaming), freezes the background on its current frame; it resumes 1.2 s (input) / 1.5 s (stream) after the last event. Pointer moves and clicks do not freeze (pointer-reactive presets, Ocean ripples).
- **Gradient drift is now a tiny canvas**: four radial gradients at 0.2x CSS resolution, at most 20-30 fps (same look: the blobs are pure soft gradients, upscaling is invisible).
- Theme / surface poll every 2 s and skipped while the user is busy.
- UI: a **Performance** group (both settings) under every background; Antigravity carries a **Heavy** warning chip; "High" is labelled heavy.

## Before / after (defaults, rig slot 2, 4K 120 Hz)

Before = shipped code (60 fps Antigravity, 30 fps others, CSS drift, no pause). After = new defaults (quality Auto, pause while typing on). Each pair of columns is before -> after; `off` is the reference from the same run.

| Preset | idle GPU CPU % | work GPU CPU % | stream->frame p95 ms | work drop/s | key->frame p95 ms |
|---|---|---|---|---|---|
| off (reference) | 25-29 -> 30 | 41-48 -> 49 | 31-32 -> 31.3 | 41-43 -> 43 | 17-25 -> 25 |
| Ocean | 38.3 -> 38.2 | 44.7 -> 49.0 | 37.6 -> 31.4 | 53.0 -> 44.9 | 32.2 -> 25.1 |
| Antigravity | 79.4 -> 53.5 | 79.3 -> 50.6 | 37.3 -> 31.1 | 60.4 -> 45.2 | 24.0 -> 27.8 |
| Gradient drift | 51.2 -> 35.8 | 57.5 -> 50.0 | 34.8 -> 31.6 | 50.2 -> 46.9 | 25.8 -> 25.0 |
| Starfield | 44.8 -> 42.5 | 52.3 -> 48.6 | 34.3 -> 32.0 | 49.2 -> 47.6 | 20.5 -> 19.2 |

Reading it: while you type, scroll or stream (the work window), every preset now costs the same as no background, within rig noise: stream-to-frame p95 31-32 ms vs 31.3 off, work GPU 49-51 % vs 49 % off, dropped frames +2 to +5 per second over off (was +10 to +20). Idle, Antigravity still costs about +23 points of GPU process CPU at Balanced (30 fps), hence the Heavy label; the others are within +5 to +12 points.

Cost classes (idle GPU process CPU over off, 4K 120 Hz, no pause), from the tier table below:

| Preset | High | Balanced | Low | Static |
|---|---|---|---|---|
| Ocean | +10 | +9 | +7 | +1 |
| Antigravity | **+53 (heavy)** | +22 | +6 | +0.5 |
| Gradient drift | +6 | +4 | +3 | +1 |
| Starfield | +24 | +12 | +6 | +1 |

## Raw tables

### A/B on the shipped code (before), run 1 (slot 2)

Per-scenario lines (the run aborted at `ag-willchange` on a driver bug, since fixed):

| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | work frame avg/p95 ms | work drop/s | key delay avg / key->frame p95 ms | stream->frame p95 ms | work GPU CPU % | bg draws/s idle/work | idle GPU busy ms/s (trace) | layers / MB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 8.33 / 8.4 | 0 | 25 | 13.13 / 25.1 | 43.4 | 10.49 / 24.8 | 32 | 47.5 | 0 / 0 | 1263.4 | 44 / 54 |
| ag | 8.82 / 8.4 | 6.59 | 79.4 | 16.94 / 33.4 | 60.36 | 11.33 / 24 | 37.3 | 79.3 | 57.3 / 40.6 | 1748.4 | 46 / 114.9 |
| ag-hidden | 8.73 / 8.4 | 5.39 | 70.4 | 17.41 / 41.6 | 61.95 | 11.3 / 28.5 | 38.9 | 76.9 | 57.5 / 40.1 | 1676.2 | 44 / 54 |
| ag-opaque | 8.88 / 8.4 | 7.39 | 83.1 | 18.26 / 33.4 | 64.71 | 10.43 / 24.3 | 35.1 | 84.6 | 57 / 40.1 | 1773.7 | 46 / 114.9 |
| ag-still | 8.83 / 8.4 | 6.79 | 32 | 15.72 / 33.4 | 55.85 | 13.26 / 27.4 | 32.7 | 49.3 | 0 / 0 | 1266.2 | 46 / 114.9 |
| ag-30fps | 8.71 / 8.4 | 5.2 | 57.7 | 15.35 / 33.4 | 54.5 | 9.63 / 18.4 | 34.8 | 69.7 | 29.4 / 25.7 | 1513.8 | 46 / 114.9 |
| ag-dpr1 | 8.64 / 8.4 | 4.2 | 83.2 | 17.53 / 41.6 | 62.38 | 9.7 / 20.3 | 41.4 | 82.2 | 58.5 / 40.2 | 1778.8 | 46 / 114.9 |
| ag-dpr0.5 | 8.68 / 8.4 | 4.8 | 45.9 | 15.09 / 33.3 | 53.25 | 10.88 / 32.3 | 33.5 | 59.6 | 57.9 / 43.8 | 1423.4 | 46 / 114.9 |

### A/B on the shipped code (before), run 2 (slot 2)

`draws/s` is only recorded for the BgLayer presets; Ocean and CSS drift show 0 there.

| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | idle renderer CPU % | idle GPU busy ms/s | work frame avg/p95 ms | work drop/s | key delay avg ms | key→frame p95 ms | stream→frame p95 ms | LoAF n / blocking ms | work GPU CPU % | work renderer CPU % | layers / MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 8.33 / 8.4 | 0 | 29 | 24.7 | 1248.1 | 12.66 / 25.1 | 40.64 | 9.09 | 17.3 | 31 | 0 / 0 | 40.7 | 106.5 | 44 / 54 |
| ag-willchange | 8.74 / 8.4 | 5.6 | 81.5 | 37.5 | 1756.7 | 16.48 / 33.4 | 58.64 | 13.18 | 49.9 | 36.3 | 5 / 38 | 76.7 | 106.1 | 46 / 114.9 |
| ocean | 8.79 / 8.4 | 6.2 | 38.3 | 35.2 | 1323 | 15.07 / 33.4 | 52.98 | 11.51 | 32.2 | 37.6 | 6 / 30.5 | 44.7 | 107.1 | 46 / 114.9 |
| ocean-dpr1 | 8.73 / 8.4 | 5.39 | 37.9 | 34.4 | 1331.6 | 13.72 / 33.2 | 46.76 | 8.54 | 24.2 | 33.3 | 3 / 29.8 | 45.6 | 106.2 | 46 / 114.9 |
| ocean-dpr0.5 | 8.7 / 8.5 | 5 | 38.9 | 35.3 | 1325.6 | 14.85 / 33.3 | 52.26 | 10.02 | 38.6 | 36.7 | 4 / 4 | 46.1 | 106.8 | 46 / 114.9 |
| ocean-still | 8.74 / 8.4 | 5.6 | 31 | 28.5 | 1251.8 | 13.35 / 25.1 | 44.74 | 9.01 | 27.2 | 31 | 3 / 63.4 | 40.2 | 101.2 | 46 / 114.9 |
| ocean-opaque | 8.7 / 8.4 | 5 | 37.5 | 36 | 1337.2 | 14.11 / 25.1 | 48.53 | 10.96 | 52.3 | 32 | 4 / 74 | 44.9 | 101.7 | 46 / 114.9 |
| drift | 8.33 / 8.4 | 0 | 51.2 | 29.8 | 1457.2 | 14.44 / 33.3 | 50.21 | 10.61 | 25.8 | 34.8 | 0 / 0 | 57.5 | 106.6 | 50 / 130 |
| drift-still | 8.33 / 8.4 | 0 | 30.7 | 28.8 | 1260.5 | 13.1 / 25.1 | 43.18 | 11.21 | 29 | 32.4 | 1 / 0 | 42.2 | 105.2 | 50 / 130 |
| starfield | 8.59 / 8.4 | 3.6 | 44.8 | 34.2 | 1382 | 14.19 / 33.2 | 49.16 | 10.34 | 20.5 | 34.3 | 3 / 0 | 52.3 | 104 | 46 / 114.9 |

### First baseline (before), slot 3, earlier the same day

Different slot and rig load, so only the relative picture counts: idle GPU process CPU off 31.7 %, Ocean 55.1, Antigravity 95.4, Gradient drift 50.9, Starfield 57.2; stream->frame p95 off 7.6 ms vs 19-33 ms with any background; work drop/s off 2.3 vs Ocean 10, Antigravity 29.6, drift 4.1, Starfield 7.2. (The stream column was lighter in that version of the probe.)

### After: every tier (new code, slot 2, `--set tiers --no-trace`)

`-auto` = the defaults (quality Auto, pause while typing on); `-<tier>-nopause` = that fixed tier with the pause off. Measured background draws/s idle/work: Antigravity auto 29.6/0 (30 fps at Balanced, frozen while busy), high 59.3/38.6, balanced 29.8/25.3, low 15/13.6, static 0/0; drift auto 20/0, high 29.6/25.6, balanced 19.9/17.7, low 10/9.6; Starfield auto 20/0, high 29.6/25.6, balanced 19.8/17.8, low 12/11.3. Ocean does not report draws.

| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | idle renderer CPU % | idle GPU busy ms/s | work frame avg/p95 ms | work drop/s | key delay avg ms | key→frame p95 ms | stream→frame p95 ms | LoAF n / blocking ms | work GPU CPU % | work renderer CPU % | layers / MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 8.33 / 8.4 | 0 | 30.3 | 24.6 | - | 13.05 / 25.1 | 43.02 | 10.26 | 25 | 31.3 | 1 / 0 | 49 | 102.7 | 44 / 54 |
| ocean-auto | 8.58 / 8.4 | 3.4 | 38.2 | 35.8 | - | 13.38 / 25.1 | 44.88 | 8.97 | 25.1 | 31.4 | 2 / 0 | 49 | 101.3 | 46 / 114.9 |
| ocean-high-nopause | 8.45 / 8.4 | 1.59 | 40.8 | 33.1 | - | 13.92 / 25.1 | 47.8 | 10.28 | 28.3 | 32.5 | 2 / 0 | 55.2 | 102.3 | 46 / 114.9 |
| ocean-balanced-nopause | 8.53 / 8.4 | 2.8 | 39.3 | 32.7 | - | 14.44 / 33.3 | 49.98 | 9.68 | 18.3 | 31.9 | 1 / 0 | 53.9 | 101.7 | 46 / 114.9 |
| ocean-low-nopause | 8.5 / 8.4 | 2.4 | 37.1 | 31 | - | 14.76 / 33.2 | 51.8 | 9.33 | 34.5 | 34.1 | 4 / 48.8 | 52.6 | 101.7 | 46 / 114.9 |
| ocean-static-nopause | 8.53 / 8.4 | 2.8 | 31.1 | 27 | - | 13.82 / 25.1 | 47 | 10.23 | 26.7 | 31.1 | 3 / 18.8 | 49 | 100.1 | 46 / 114.9 |
| antigravity-auto | 8.61 / 8.4 | 3.8 | 53.5 | 33.2 | - | 13.44 / 25.1 | 45.19 | 10.36 | 27.8 | 31.1 | 2 / 0 | 50.6 | 104.3 | 46 / 114.9 |
| antigravity-high-nopause | 8.49 / 8.4 | 2.2 | 83.3 | 40 | - | 17.89 / 41.6 | 63.43 | 10.12 | 24 | 44.1 | 4 / 6.6 | 81.8 | 134.9 | 46 / 114.9 |
| antigravity-balanced-nopause | 8.52 / 8.4 | 2.6 | 52.6 | 33.9 | - | 15.49 / 33.4 | 55.12 | 10.37 | 25.3 | 36.1 | 3 / 20.8 | 66.2 | 132.3 | 46 / 114.9 |
| antigravity-low-nopause | 8.52 / 8.4 | 2.6 | 36 | 36.4 | - | 13.88 / 33.3 | 47.61 | 10.38 | 25.7 | 32 | 1 / 0 | 53 | 134.8 | 46 / 114.9 |
| antigravity-static-nopause | 8.52 / 8.4 | 2.6 | 30.8 | 33.2 | - | 13.86 / 25.1 | 47.47 | 11.23 | 24.6 | 31.7 | 3 / 14 | 49.4 | 132.9 | 46 / 114.9 |
| drift-auto | 8.43 / 8.4 | 1.4 | 35.8 | 27.8 | - | 13.75 / 25.2 | 46.87 | 10.34 | 25 | 31.6 | 0 / 0 | 50 | 133.2 | 46 / 114.9 |
| drift-high-nopause | 8.49 / 8.4 | 2.2 | 36.5 | 30.5 | - | 14.06 / 25.1 | 48.64 | 9.9 | 46.1 | 31.5 | 5 / 0 | 51.6 | 135.4 | 46 / 114.9 |
| drift-balanced-nopause | 8.45 / 8.4 | 1.59 | 34.7 | 31.4 | - | 14.58 / 33.3 | 50.99 | 11.08 | 28.2 | 32.3 | 3 / 0 | 51.3 | 138.3 | 46 / 114.9 |
| drift-low-nopause | 8.55 / 8.4 | 3 | 33.3 | 35.1 | - | 14.13 / 33.3 | 48.83 | 11.4 | 26.5 | 30.7 | 3 / 0 | 50.7 | 133.1 | 46 / 114.9 |
| drift-static-nopause | 8.52 / 8.4 | 2.6 | 31.5 | 32 | - | 13.75 / 25.1 | 46.8 | 8.97 | 19 | 31.9 | 5 / 38 | 49.3 | 132.3 | 46 / 114.9 |
| starfield-auto | 8.52 / 8.4 | 2.6 | 42.5 | 33.9 | - | 13.94 / 25.1 | 47.64 | 9.7 | 19.2 | 32 | 2 / 0 | 48.6 | 134.4 | 46 / 114.9 |
| starfield-high-nopause | 8.49 / 8.4 | 2.2 | 54.7 | 35.3 | - | 15.73 / 33.3 | 55.92 | 12.61 | 35.2 | 37.9 | 4 / 0 | 66 | 136.1 | 46 / 114.9 |
| starfield-balanced-nopause | 8.64 / 8.4 | 4.2 | 42.6 | 29.6 | - | 14.12 / 33.3 | 48.84 | 8.43 | 19.2 | 30.8 | 2 / 8.9 | 58 | 106.7 | 46 / 114.9 |
| starfield-low-nopause | 8.47 / 8.4 | 2 | 36.5 | 26.8 | - | 13.55 / 25.1 | 45.77 | 9.31 | 20.3 | 30.8 | 2 / 0 | 54.5 | 106.7 | 46 / 114.9 |
| starfield-static-nopause | 8.5 / 8.4 | 2.4 | 31 | 27.8 | - | 13.76 / 33.3 | 46.9 | 9.1 | 19.7 | 31.6 | 4 / 4.7 | 48.9 | 105.8 | 46 / 114.9 |

## Unverified / open

- Idle dropped frames: with any canvas background present, even a Static one that draws nothing, the probe sees ~2-4 dropped frames per second at 120 Hz idle (0 with the background off). The probe's own rAF loop forces a composite every vsync, and the bigger transparent layer stack (115 MB vs 54 MB) occasionally misses the 8.3 ms deadline. In normal use an idle app produces no frames, so this may not be visible; not proven either way. The < 1 dropped frame per second target is met relative to off only in the work window (+2 to +5 /s over off, down from +10 to +20); absolute work drop/s on rig is ~43 even with no background.
- Antigravity at Balanced still costs ~+22 points of GPU process CPU idle. A WebGL (instanced capsules) or worker/OffscreenCanvas renderer could cut the stroke replay cost; not tried, hence the Heavy label instead.
- Only measured on rig (RTX 3080, 120 Hz, 175 %). Not measured on FOX itself, on 60 Hz screens or on integrated GPUs; the Auto governor is the safety net there.
- Ocean draw cost is not exported to `__t3pBgPerf`, so its draws/s column reads 0; its GPU numbers are measured.
- The Auto governor stepping down was verified by unit tests only; no rig run pushed it into a slow state on purpose.

## After merging dim and blur (WP-13B)

The merged build, same slot, setup and driver (`--set merge --no-trace`). Defaults = quality Auto + pause while typing, dim 0, blur 0. Blur is a CSS `filter` on the canvas (Gradient drift bakes it into the blobs); dim is one flat opacity layer.

Summary (run 2, two interleaved repeats, work window = typing + scrolling + streaming):

| Scenario | idle GPU CPU % | work GPU CPU % | stream->frame p95 ms | work drop/s |
|---|---|---|---|---|
| off | 31-33 | 51-52 | 36 | 49-52 |
| Ocean, defaults | 39 | 51 | 31-33 | 45 |
| Antigravity, defaults | 53 | 50-52 | 31 | 44-45 |
| Antigravity, dim 40 | 53-57 | 51-55 | 32-34 | 46-55 |
| Ocean, dim 40 | 39-40 | 51 | 31-33 | 47 |
| Antigravity, blur 8 | 57-58 | **66-67** | 33-34 | 49-50 |
| Ocean, blur 8 | 56-61 | **65-72** | 32-50 | 47-66 |

- Defaults still match off while typing: work GPU 50-52 % vs 51-52 %, stream p95 31-33 ms vs 36 ms. The before/after table above holds after the merge.
- Dim costs nothing measurable (one extra 4K layer, +30 MB layer memory).
- Blur costs about +15 points of GPU process CPU while you type, even though the background is frozen: the blurred layer's filter is recomputed whenever the app above it changes. Neither governor sees that cost (it is in the GPU process, not in draw time or long tasks), so the blur is not shed. Blur 20 was not worse than blur 8 in run 1. Gradient drift with blur 20 (baked in) stays free.
- The 13B README measurement (no trend against blur) used an emulated 4K viewport, an idle page and draw-time metrics; this one uses a maximized window, a typing/streaming workload and GPU process CPU.

### Raw: merge run 1 (one pass; rig load rose from `antigravity-dim40` on, see run 2)

| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | idle renderer CPU % | idle GPU busy ms/s | work frame avg/p95 ms | work drop/s | key delay avg ms | key→frame p95 ms | stream→frame p95 ms | LoAF n / blocking ms | work GPU CPU % | work renderer CPU % | layers / MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 8.33 / 8.4 | 0 | 24 | 19.8 | - | 12.04 / 25.1 | 36.66 | 6.41 | 14.9 | 29.9 | 1 / 0 | 41.5 | 93.7 | 44 / 54 |
| ocean-auto | 8.49 / 8.4 | 2.2 | 30.1 | 26.3 | - | 11.44 / 25 | 32.38 | 4.56 | 15 | 28.7 | 0 / 0 | 40.7 | 91 | 46 / 114.9 |
| antigravity-auto | 8.49 / 8.4 | 2.2 | 45.4 | 27.2 | - | 11.5 / 25 | 32.82 | 6.87 | 16.1 | 28.4 | 0 / 0 | 40.6 | 91.9 | 46 / 114.9 |
| drift-auto | 8.46 / 8.4 | 1.8 | 28.4 | 26 | - | 11.71 / 25 | 34.28 | 6.55 | 15.8 | 28.5 | 1 / 0 | 40.8 | 95.2 | 46 / 114.9 |
| starfield-auto | 8.47 / 8.4 | 2 | 35.8 | 25.8 | - | 11.34 / 25 | 31.63 | 4.98 | 15.1 | 28.7 | 0 / 0 | 40.8 | 90.6 | 46 / 114.9 |
| antigravity-blur8 | 8.47 / 8.4 | 2 | 45.7 | 26.3 | - | 12.02 / 25.1 | 36.51 | 6.11 | 15.5 | 29.4 | 0 / 0 | 51.2 | 94.4 | 46 / 114.9 |
| antigravity-blur20 | 8.47 / 8.4 | 2 | 44.6 | 26.7 | - | 11.67 / 25 | 34.14 | 6.48 | 16.1 | 29.3 | 0 / 0 | 57.2 | 95.5 | 46 / 114.9 |
| antigravity-blur20-nopause | 8.43 / 8.4 | 1.4 | 44.4 | 28.4 | - | 12.31 / 25 | 38.44 | 6.47 | 16.5 | 30.1 | 2 / 0 | 56.5 | 96 | 46 / 114.9 |
| antigravity-dim40 | 8.59 / 8.4 | 3.6 | 54.9 | 33.4 | - | 15.82 / 33.4 | 56.19 | 10.83 | 22.7 | 41.3 | 6 / 0 | 50.4 | 111.1 | 47 / 145.3 |
| ocean-blur8 | 8.65 / 8.4 | 4.4 | 57.9 | 36.4 | - | 15.18 / 33.3 | 53.6 | 8.91 | 17.9 | 35 | 3 / 0 | 66.4 | 108.4 | 46 / 114.9 |
| ocean-blur20 | 8.67 / 8.4 | 4.6 | 60 | 37.4 | - | 18.67 / 41.6 | 65.78 | 11.35 | 23.7 | 47.3 | 7 / 0 | 74 | 109.6 | 46 / 114.9 |
| ocean-blur20-nopause | 8.5 / 8.4 | 2.4 | 61.2 | 41.5 | - | 19.69 / 41.7 | 68.69 | 11.62 | 30.5 | 41.4 | 9 / 44.8 | 74.6 | 108.1 | 46 / 114.9 |
| ocean-dim40 | 8.46 / 8.4 | 1.8 | 39.3 | 31.7 | - | 13.22 / 25.1 | 44.01 | 8.32 | 16.5 | 32 | 1 / 0 | 51.3 | 100.8 | 47 / 145.3 |
| drift-blur20 | 8.68 / 8.4 | 4.8 | 37.1 | 33.5 | - | 13.44 / 25.1 | 45.31 | 9.1 | 18.7 | 32 | 4 / 0 | 50.5 | 100.1 | 46 / 114.9 |

### Raw: merge run 2 (two interleaved repeats)

| scenario | idle frame avg/p95 ms | idle drop/s | idle GPU CPU % | idle renderer CPU % | idle GPU busy ms/s | work frame avg/p95 ms | work drop/s | key delay avg ms | key→frame p95 ms | stream→frame p95 ms | LoAF n / blocking ms | work GPU CPU % | work renderer CPU % | layers / MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 8.33 / 8.4 | 0 | 32.7 | 30.2 | - | 14.84 / 33.4 | 52.01 | 8.93 | 21.1 | 35.8 | 1 / 0 | 51.6 | 138.3 | 44 / 54 |
| ocean-auto | 8.47 / 8.4 | 2 | 39.4 | 30.6 | - | 13.36 / 25.1 | 44.79 | 8.63 | 17.3 | 32.8 | 0 / 0 | 50.7 | 100.4 | 46 / 114.9 |
| antigravity-auto | 8.56 / 8.4 | 3.2 | 53.5 | 32.6 | - | 13.28 / 25.1 | 44.3 | 10.5 | 25 | 31 | 1 / 0 | 50 | 102.5 | 46 / 114.9 |
| antigravity-blur8 | 8.56 / 8.4 | 3.2 | 58.4 | 33.4 | - | 14.21 / 25.2 | 49.19 | 10.3 | 24.4 | 33.7 | 2 / 0 | 66.2 | 108.5 | 46 / 114.9 |
| antigravity-dim40 | 8.55 / 8.4 | 3 | 53.3 | 35.8 | - | 13.65 / 33.2 | 46.27 | 11.46 | 25.5 | 31.9 | 0 / 0 | 50.7 | 103.3 | 47 / 145.3 |
| ocean-blur8 | 8.53 / 8.4 | 2.8 | 56.3 | 31 | - | 13.7 / 25.1 | 46.71 | 10.56 | 23.7 | 32.4 | 1 / 0 | 65.3 | 104.3 | 46 / 114.9 |
| ocean-dim40 | 8.47 / 8.4 | 2 | 39 | 31.8 | - | 13.69 / 25.1 | 46.75 | 11.46 | 23.4 | 32.7 | 0 / 0 | 51 | 101.4 | 47 / 145.3 |
| off | 8.33 / 8.4 | 0 | 31.1 | 24.7 | - | 14.11 / 25.1 | 48.58 | 10.33 | 26.6 | 36.2 | 2 / 0 | 51.3 | 103 | 44 / 54 |
| ocean-auto | 8.49 / 8.4 | 2.2 | 39.3 | 32 | - | 13.5 / 25.1 | 45.36 | 9.58 | 23.5 | 30.7 | 2 / 0 | 50.8 | 99.8 | 46 / 114.9 |
| antigravity-auto | 8.5 / 8.4 | 2.4 | 52.6 | 31.9 | - | 13.39 / 25.1 | 44.83 | 9.11 | 18.6 | 31.3 | 0 / 0 | 51.7 | 100.3 | 46 / 114.9 |
| antigravity-blur8 | 8.52 / 8.4 | 2.6 | 56.9 | 32.5 | - | 14.42 / 33.3 | 50.29 | 9.91 | 24.1 | 32.5 | 0 / 0 | 67 | 106.3 | 46 / 114.9 |
| antigravity-dim40 | 8.55 / 8.4 | 3 | 57.1 | 34 | - | 15.56 / 33.4 | 55.27 | 8.74 | 20.7 | 34.1 | 1 / 0 | 55.1 | 112.2 | 47 / 145.3 |
| ocean-blur8 | 8.49 / 8.4 | 2.2 | 60.6 | 34.4 | - | 18.87 / 41.7 | 66.04 | 10.92 | 28.3 | 49.5 | 9 / 0 | 71.8 | 112 | 46 / 114.9 |
| ocean-dim40 | 8.47 / 8.4 | 2 | 40.2 | 32.8 | - | 13.85 / 25.1 | 47.45 | 10.34 | 27.1 | 31 | 0 / 0 | 51.2 | 101.1 | 47 / 145.3 |

### Unverified after the merge

- Blur fix not done: rendering the blur into the canvas (`ctx.filter`, only when a frame is drawn) instead of a CSS filter should make a frozen blurred background free again; not tried.
- The Auto governor shedding blur before lowering the tier is unit-tested only; no rig run forced it.

## Blur drawn into the canvas (WP-13D)

Problem (from the merge run above): a CSS `filter: blur()` on the background canvas cost about +15 points of GPU process CPU while typing, even with the background frozen, and once pushed stream-to-frame p95 to 49.5 ms. No governor saw it.

### Root cause

A CSS filter is applied by the compositor (viz) every time the layer is composited, not once when the canvas content changes. The app above the transparent surfaces changes on every typing/streaming frame, so the filtered 4K layer (plus its `will-change: transform` surface and the zoom transform) was run through the blur render pass again for each of those frames. Freezing the canvas stops the draws, not the filter. The cost is paid in the GPU process, outside our draw time and outside long animation frames, so `BlurShed`, `FrameGovernor` and `QualityGovernor` had no signal.

### Options and decision

| Option | Result |
|---|---|
| (a) `ctx.filter = blur()` on a reduced-resolution offscreen canvas, blitted to the visible canvas once per drawn frame | **Chosen** for Antigravity, Starfield and Ocean. The blur runs inside the canvas raster at draw time only; the visible canvas is a plain bitmap to the compositor. Frozen = free. |
| (b) Render low-res and upscale for the blur | Already used (`blurRenderFactor`, down to 0.5x) to shrink the blit; bilinear upscale alone cannot reach 20 px blur, so it complements (a), it does not replace it. |
| (c) CSS filter only on a static still | Not needed: (a) is cheap while animating too. |
| (d) Drop `will-change` / transform | Done as part of (a): no filter, `will-change` or zoom transform on the canvas any more (the edge margin is a slightly oversized `drawImage`). |
| (e) Per kind | Gradient drift keeps its baked-in blur (blobs get bigger and flatter, no blit). Ocean blits only after a frame that changed a cell. No kind needed the slider hidden or capped. |

Not added: a new governor input. With the blur in the canvas, its cost shows up in the draw time that `BlurShed`, `FrameGovernor` and the Auto governor already watch (the blit is part of `paintOnce`), so blur is still shed first when frames get slow.

### Before / after (rig slot 2, maximized 4K, 120 Hz, `--set blur --no-trace`, same run for old and new)

Old = CSS filter build (HEAD before this change), new = in-canvas blur. GPU = GPU process CPU %, "work" = typing + scrolling + streaming. stream = stream-to-frame p95 ms.

| Scenario | idle GPU old -> new | work GPU old -> new | stream p95 old -> new |
|---|---|---|---|
| off (reference) | 40.1 -> 39.7 | 54.1 -> 54.2 | 29.9 -> 29.8 |
| Antigravity blur 0 | 61.0 -> 60.1 | 56.7 -> 54.3 | 30.7 -> 30.4 |
| Antigravity blur 8 | 56.6 -> 49.1 | 61.6 -> **55.4** | 29.4 -> 28.8 |
| Antigravity blur 20 | 54.2 -> 46.7 | 60.8 -> **54.3** | 29.3 -> 29.3 |
| Ocean blur 0 | 45.8 -> 46.7 | 54.1 -> 54.5 | 29.9 -> 29.2 |
| Ocean blur 8 | 53.1 -> 47.7 | 59.6 -> **54.2** | 29.6 -> 29.1 |
| Ocean blur 20 | 55.2 -> 35.5 | 60.9 -> **54.6** | 29.4 -> 29.8 |
| Starfield blur 0 | 52.4 -> 50.7 | 54.5 -> 55.8 | 29.9 -> 29.2 |
| Starfield blur 8 | 55.4 -> 47.8 | 62.1 -> **56.4** | 29.4 -> 30.5 |
| Starfield blur 20 | 53.3 -> 46.3 | 61.5 -> **54.7** | 29.8 -> 29.7 |
| Gradient drift blur 20 (baked, unchanged) | 44.6 -> 43.5 | 54.9 -> 53.9 | 29.2 -> 29.5 |

Same set without the pause while typing (the animation keeps running during the work window): old -> new work GPU Antigravity blur 8 65.2 -> 59.7, blur 20 63.3 -> 57.1; Ocean blur 8 63.0 -> 57.7, blur 20 65.8 -> 57.2; Starfield blur 8 63.7 -> 59.6, blur 20 68.3 -> 56.4 (the old Starfield blur 20 row also had stream p95 34.8 ms and 44 drops/s, new 30.7 and 39.5).

Result: blur 8 and 20 are within about 2 points of blur 0 while typing on every preset (old build: +5 to +8), idle is no higher than blur 0 (it is lower: the blurred canvas renders at 0.5 to 0.8x), and stream latency is unchanged.

### Noise and caveats

- Rig load changed between repeats. Two later runs of the new build (`blur-new2`, `blur-new3`) were taken while something else loaded rig: `off` itself went from 54 to 65 work GPU. Within those runs blur 0 and blur 8 or 20 are still equal (run 3: Ocean 65.8 / 65.7 / 67.8, Starfield 65.9 / 66.1 for blur 0 / 20, Antigravity 66.4 / 65.8), but the absolute numbers are not comparable to the table.
- The old numbers above come from one run; the earlier merge-run numbers (blur 8 about +15) were taken in a different rig state.
- Visual check not done on rig: the blur looks the same by construction (same gaussian sigma = the CSS px, scaled by the internal resolution) but nobody compared screenshots.
- `ctx.filter` is a Chromium canvas feature (Electron here is Chrome 152). A context that ignored it would show the layer unblurred rather than break; not tested.
- Each drawn frame now also pays one blit (GPU raster of one blur pass at 0.5 to 0.8x of the tier resolution); it is included in the idle numbers above.

## WP-17: lifecycle rewrite and the Antigravity drop

The maintainer reported the animated backgrounds as "extremely buggy". Each bug was reproduced on rig slot 2 (maximized 4K, 2195x1187 CSS px at dpr 1.75, 120 Hz) over CDP. The scripted repro covers:

- turning each kind on, rapid switching, master on/off;
- typing and streaming, with the dock open and closed;
- slider churn, theme toggles, window resize, dpr override;
- dim and blur, every quality tier, hide/show;
- Custom HTML takeover, sidebar collapse;
- 10 minutes idle.

### Bugs and root causes

| # | Symptom | Repro | Root cause |
|---|---|---|---|
| 1 | **Every preset frozen forever** with the defaults (0 draws/s, "the background never moves") | turn any kind on with the plugin dock open, or with any plugin whose UI re-renders; draws stay 0 | the pause-while-typing gate counted DOM mutations from plugin UI (dock re-renders, our own layers) as chat streaming, so it never went idle. An open dock also puts `t3p-dock-open` on `<body>`, so a first fix that skipped "nodes inside plugin UI" matched every node and hid real streaming |
| 2 | Theme switch repaints 0.8 to 1.9 s late, and never while frozen or static | toggle dark/light; time to the first draw | the palette came from a 1-2 s computed-style poll that was skipped while busy and did not repaint a frozen frame |
| 3 | Minimizing or covering the window dropped a quality tier | minimize 10 s, restore: tier went balanced to low | the browser throttles rAF in a hidden or occluded window; Auto read the late frames as a slow page |
| 4 | Wakeups at the display rate | rAF callbacks ~121/s for a 20 fps background | every loop requested an animation frame each vsync and skipped most of them |
| 5 | Ocean jumps and reshuffles | Ocean jumped ~4 s of motion on start; every resize re-rolled every letter; a blank frame after resize; ripples aged with the speed setting | Ocean had its own second copy of the engine (loop, poll, listeners, resize path) with its own bugs: time started at t=4, letters came from a random pass per layout, the resize cleared the canvas and waited for the next frame |
| 6 | Blank or stretched frame after a resize or zoom (all kinds) | resize the window; screenshot right after | `window.resize` resized the backing store (clearing it) and waited for the next 20-30 fps frame; zoom and monitor moves (dpr) were not watched |
| 7 | Antigravity snapped to a new layout on any slider change | drag Intensity | `configure()` relaid out the particle field on every settings change, not only on a count change |
| 8 | A modal backdrop or a translucent card lost its fill | open a dialog with a background on | `markSurfaces` cleared any surface with a background colour, including semi-transparent ones |
| 9 | Gradient drift froze with Follow accent on | Drift on, follow accent; draws stay 0 | the colour probe element `resolve()` adds to read the accent was itself counted as a DOM mutation, feeding bug 1 |

### Fix: one engine

`src/bg-base.ts` (`CanvasBg`) is the only lifecycle owner for all kinds, Ocean included (`src/ocean.ts` is now a `CanvasBg` subclass with `incremental` drawing):

- **Mount and unmount are idempotent.** Every listener, observer and timer goes through one disposer list. `stop()` runs all of them. A second `update()` never adds a second set (tests check the listener count against a baseline).
- **Frame loop.** A timer sleeps until the next frame is due (minus 8 ms), then one rAF draws it. A 20 fps layer wakes the page ~21 times a second (was 121).
- **Sizing.** A `ResizeObserver` on the canvas, plus a `(resolution: Xdppx)` media query for zoom and monitor moves. The canvas is resized and repainted inside the callback, so no blank frame shows.
- **Theme.** A `MutationObserver` on `<html>` (class, style, `data-theme`) plus `prefers-color-scheme`. The palette refreshes and repaints at once, also while frozen or static: ~30 ms after the toggle (was 0.8 to 1.9 s).
- **Resume can't get stuck.**
  - The activity gate ignores mutations inside plugin UI. It walks up from the node and stops before `<body>`/`<html>`.
  - Auto quality ignores frames that came more than 250 ms late (throttled, not slow).
  - Visibility pauses at once. A blur pauses after 5 s. Both resume on the next event.
- **Smaller fixes.**
  - Surfaces are cleared only if fully opaque.
  - The colour probe (`src/bg-surfaces.ts`) has a `t3p-` id, and the activity monitor ignores records that only add or remove plugin nodes, so reading a colour never looks like streaming.
  - `syncBackgrounds()` stops the other kinds before it starts the new one, so two canvases never coexist.

Tests: `plugins/artwork/test/lifecycle.test.ts` runs, per kind:

- idempotent mount and unmount, with no leaked listeners;
- hidden, blur, reduced motion and typing pauses, and that each one resumes;
- resize repaints synchronously;
- the theme observer;
- switching between kinds;
- frame timers;
- the throttled-frame rule;
- Ocean's cell-stable letters and real-time ripples;
- the plugin-UI activity filter, including the `<body>` dock class;
- `isOpaqueColor`.

### Real-app repro after the fix (rig slot 2)

- One canvas per kind. Rapid switching (3 rounds over every kind) leaves exactly one canvas, one style and one `<html>` marker. Master off removes all of them, and the dim with them.
- Typing and streaming freeze the frame (0 draws) and it resumes within 2.5 s, with the dock open and closed. Before: it never resumed.
- Theme toggle repaints in 32 to 36 ms on every kind, also when static.
- Window resize and a dpr override keep the image (no blank frame). The canvas is resized to the tier budget.
- Dim and blur land on the right element. Every tier gives the expected frame rate (Ocean/Starfield 30/20/12/0, Drift 30/20/10/0) and resolution.
- Hide/show pauses (2 rAF/s while hidden) and resumes.
- Custom HTML background takes over (no canvas) and gives the preset back.
- Sidebar collapse/expand keeps animating at the same rate.
- No console errors or exceptions in any scenario.
- 10 minutes idle (Ocean): still animating every minute (5,100 to 6,100 letter draws/s, 22 rAF/s), JS heap 50.4 MB at the start, 51.4 MB at the end (peaks of 60-62 MB were collected), no errors.

### Before / after (`tools/rig/perf/bg-perf.mjs --set wp17`, rig slot 2)

Before = the build before WP-17. After = this branch. `default` = the shipped defaults (quality Auto, pause while typing). Idle = nothing but the background. Work = typing, scrolling and a fake stream. The numbers are GPU process CPU % and dropped frames per second. Rig load moves between runs, so compare against `off` from the same run.

| Scenario | idle draws/s before -> after | idle GPU % before -> after | work drop/s before -> after |
|---|---|---|---|
| off | 0 -> 0 | 30.1 -> 30.0 | 0.6 -> 1.2 |
| ocean-default | **0** -> 20 | 29.9 -> 33.8 | 0.6 -> 1.2 |
| drift-default | **0** -> 19.8 | 29.9 -> 30.1 | 0 -> 0.8 |
| starfield-default | **0** -> 19.6 | 30.1 -> 38.0 | 0.6 -> 0.4 |
| antigravity-default | **0** -> 29.4 | 30.2 -> 50.4 | 0.6 -> 1.4 |
| ocean-high-nopause | **0** -> 29.2 | 34.8 -> 35.4 | 2.0 -> 3.3 |
| drift-high-nopause | 30 -> 29.6 | 31.4 -> 31.6 | 1.8 -> 2.8 |
| starfield-high-nopause | 30 -> 29.6 | 48.1 -> 50.7 | 4.6 -> 11.2 |
| antigravity-high-nopause | 59.5 -> 58.5 | 76.2 -> 71.2 | 25.5 -> 24.4 |

How to read it:

- Before, the defaults never animated (bug 1). Ocean didn't animate even with the pause off. Their low "before" cost is the cost of a still picture.
- After, every default animates while idle. It still freezes during work, so work drops equal `off` on every kind.
- The "after" idle cost is the real price of the animation. Antigravity's is +20 points.

Always-animating cost at Balanced (pause off, 3 interleaved repeats, `--repeat 3`, a busier rig so `off` is higher):

| Scenario | idle GPU % | work GPU % | work drop/s | frame p95 ms |
|---|---|---|---|---|
| off | 41.7-42.5 | 45.8-45.9 | 1.6-2.0 | 8.4 |
| drift | 43.8-44.1 | 47.0-47.5 | 4.1-4.5 | 8.4 |
| ocean | 47.5-48.2 | 49.7-50.8 | 10.0-10.9 | 8.5 |
| starfield | 53.3-53.8 | 54.6-56.5 | 10.4-12.2 | 8.5-16.6 |
| antigravity | 63.9-66.1 | 65.6-67.2 | 16.8-18.9 | 16.7 |

### Where Antigravity's cost goes (A/B, Balanced, pause off)

| Variant | idle GPU % | work drop/s |
|---|---|---|
| off | 33.4 | 1.8 |
| Antigravity | 51.1 | 12.0 |
| canvas `display:none` (JS and canvas commands still run) | 50.5 | 11.3 |
| square line caps instead of round | 50.4 | 10.7 |
| Low tier (15 fps, 0.5x) | 35.8 | 5.1 |
| 2D context on the CPU (`willReadFrequently`), separate run, `off` 30.7 / 1.8 | GPU 48.0 -> 34.7, renderer 36.2 -> 44.4 | 9.2 -> 10.1 |

A hidden canvas costs the same as a visible one, so the cost is rastering ~1700 strokes per frame, not compositing. Moving the raster to the CPU only moves the cost to the renderer, and the drops stay. Line caps don't matter. Only fewer frames and pixels help, and the Low tier no longer looks like the preset. A WebGL rewrite could change that. It was not attempted here.

### Verdicts

| Preset | Verdict | Evidence |
|---|---|---|
| Ocean | **KEEP** | defaults: animates idle at 20 fps for +4 GPU points, frozen during work (drops = off). Always-animating Balanced: +6 GPU, ~+8 drops/s |
| Gradient drift | **KEEP** | the cheapest: +0 to +2 GPU, +2.5 drops/s even with the pause off |
| Starfield | **KEEP** | defaults: +8 GPU idle, drops = off during work. With the pause off at Balanced: ~+10 drops/s and frame p95 16.6 ms in 2 of 3 runs. Smooth only with the default pause |
| Antigravity | **DROP** | +20 GPU idle even on the defaults, +22 at Balanced, 16.8 to 18.9 drops/s and frame p95 16.7 ms whenever it animates. No compositing or raster fix helped (table above) |

How the drop works:

- Code, tests, panel entry and screenshot are removed.
- A saved `bgKind: "antigravity"` comes back as Ocean. The settings runtime (`effectiveValue`, `packages/renderer-runtime/src/storage.ts`) returns the default for an enum value that is no longer an option, and writing it is rejected (`does not fit the enum schema`, seen on rig). A panel test covers the fallback.
- Low power now caps at 20 fps. 30 was above every kept preset's High.

### Unverified (WP-17)

- Real provider streaming and scrolling long real threads were not driven. Streaming was the synthetic stream column plus DOM bursts in the real app.
- Only rig was measured (RTX 3080, 120 Hz, 175 %). 60 Hz screens, integrated GPUs and FOX itself were not.
- Visual quality was checked by draws and canvas state, not by comparing screenshots side by side.
