export interface VirtualWindow {
  /** First row index to render (inclusive). */
  start: number;
  /** Last row index to render (exclusive). */
  end: number;
  /** Total scroll height in px. */
  totalHeight: number;
}

/**
 * Fixed-row-height windowing. Renders only the rows in view plus `overscan` rows on each side,
 * so a 10 000-row list costs the same DOM as a 30-row one.
 */
export function computeWindow(args: {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewHeight: number;
  overscan?: number;
}): VirtualWindow {
  const { count, rowHeight } = args;
  const overscan = args.overscan ?? 6;
  const totalHeight = count * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight: 0 };
  const top = Math.max(0, Math.min(args.scrollTop, Math.max(0, totalHeight - 1)));
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(1, args.viewHeight)) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
    totalHeight,
  };
}

/** scrollTop that puts row `index` in the middle of the view (clamped). */
export function scrollTopFor(index: number, rowHeight: number, viewHeight: number, count: number): number {
  const max = Math.max(0, count * rowHeight - viewHeight);
  return Math.max(0, Math.min(max, index * rowHeight - (viewHeight - rowHeight) / 2));
}
