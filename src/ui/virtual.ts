/**
 * Row-window math shared by the list surfaces that can hold more rows than a DOM should
 * (armies roster, compendium reader). No Svelte, no state: `tests/ui/armyModel.test.ts` covers
 * the arithmetic, and each consumer owns its own scroll container and measurement.
 *
 * Two consumer-side rules come with it, both learned the hard way (D-266):
 *  1. Render the slice at a **fixed pitch** of `rowHeight`, pads included — the arithmetic assumes
 *     it, and a row that wraps changes the scroll range under the reader.
 *  2. The pad elements must not be able to shrink. In a column flex container with a `max-height`
 *     they are flex items, so the default `flex-shrink: 1` collapsed them to 0 px and the list
 *     could never scroll past its first window; make the container a block, or give the pads
 *     `flex: 0 0 auto`.
 */
export interface RowWindow {
  /** First row to render (inclusive). */
  start: number;
  /** Last row to render (exclusive). */
  end: number;
  /** Spacer height above the rendered slice, in px. */
  padTop: number;
  /** Spacer height below the rendered slice, in px. */
  padBottom: number;
}

/** Virtualization math (fixed row height): which slice to render, and pads. */
export function windowRows(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): RowWindow {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(total, first + visible);
  return {
    start: first,
    end,
    padTop: first * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}
