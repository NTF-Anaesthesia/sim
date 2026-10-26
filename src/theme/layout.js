// @ts-check
// Turn a theme's cells into boxes: skip cells whose module is off or unknown, then share each stack's area among the
// cells still shown. Pure; boxes are in grid units (fractions allowed), the view turns them into percentages.

/**
 * @typedef {{ module: string, part: string, x: number, y: number, w: number, h: number, stack?: string }} Cell
 * @param {Record<string, any>} theme
 * @param {(cell: Cell) => boolean} isShown true when the cell's module is on and the part exists
 * @returns {Cell[]}
 */
export function layoutCells(theme, isShown) {
  /** @type {Cell[]} */
  const all = theme.layout.cells;
  const shown = all.filter(isShown);
  /** @type {Map<string, Cell[]>} */
  const stacks = new Map();
  for (const c of all) if (c.stack && !stacks.has(c.stack)) stacks.set(c.stack, []);
  for (const c of shown) if (c.stack) /** @type {Cell[]} */ (stacks.get(c.stack)).push(c);
  /** @type {Cell[]} */
  const out = [];
  for (const c of shown) if (!c.stack) out.push({ ...c });
  for (const [name, members] of stacks) {
    if (!members.length) continue;
    const declared = all.filter((c) => c.stack === name);
    const top = Math.min(...declared.map((c) => c.y));
    const bottom = Math.max(...declared.map((c) => c.y + c.h));
    // cells declared at the same spot (e.g. etco2 RR and rr) must not both take a share
    const total = members.reduce((s, c) => s + c.h, 0);
    let y = top;
    for (const c of members) {
      const h = ((bottom - top) * c.h) / total;
      out.push({ ...c, y, h });
      y += h;
    }
  }
  return out;
}
