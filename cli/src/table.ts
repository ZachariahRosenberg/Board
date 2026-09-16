// Shared CLI table renderer (P3-3): pad columns to the widest cell and trim
// the ragged right edge. Extracted byte-identical from boards.ts (token.ts had
// a copy) — the rendered output is dogfood-visible and must not change.
export function renderTable(header: string[], rows: string[][]): string[] {
  const widths = header.map(
    (label, i) =>
      label.length +
      rows.reduce((max, row) => Math.max(max, row[i].length - label.length), 0),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i], " "))
      .join("  ")
      .trimEnd();
  return [render(header), ...rows.map(render)];
}
