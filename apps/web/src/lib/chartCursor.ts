/**
 * Converts a horizontal viewport pointer coordinate (`clientX`) over an SVG chart plot
 * into a bounded simulation timestamp in seconds (`[0, maxX]`).
 */
export function chartClientXToTimeS(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  maxX: number,
  svgWidth = 560,
  padX = 4,
): number {
  const safeMaxX = Math.max(0.01, maxX);
  const safeRectW = Math.max(1, rectWidth);
  const safeSvgW = Math.max(1, svgWidth);
  const svgX = ((clientX - rectLeft) / safeRectW) * safeSvgW;
  const plotW = Math.max(1, safeSvgW - padX * 2);
  const frac = Math.max(0, Math.min(1, (svgX - padX) / plotW));
  return Number((frac * safeMaxX).toFixed(2));
}

/**
 * Converts a timestamp in seconds (`[0, maxX]`) into a CSS left percentage (`0..100`)
 * matching the inner `[padX, svgWidth - padX]` SVG plot coordinate system.
 */
export function chartTimeSToPercent(timeS: number, maxX: number, svgWidth = 560, padX = 4): number {
  const safeMaxX = Math.max(0.01, maxX);
  const safeSvgW = Math.max(1, svgWidth);
  const clamped = Math.max(0, Math.min(safeMaxX, timeS));
  const plotW = Math.max(1, safeSvgW - padX * 2);
  const svgX = padX + (clamped / safeMaxX) * plotW;
  return Number(((svgX / safeSvgW) * 100).toFixed(3));
}
