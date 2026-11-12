export interface EdgeLabelLayoutInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  labelX: number;
  labelY: number;
  labelTextLength: number;
  hasLeadingIcon?: boolean;
}

export interface EdgeLabelPlacement {
  x: number;
  y: number;
  isOffset: boolean;
  stemHeight: number;
}

/**
 * Computes edge pill coordinates so labels stay legible even when two horizontally
 * aligned service cards sit close together (`gap < estimated pill width`), lifting
 * the pill cleanly above the card band with a vertical hairline stem instead of
 * letting node cards clip either side.
 */
export function computeEdgeLabelPlacement(input: EdgeLabelLayoutInput): EdgeLabelPlacement {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    labelX,
    labelY,
    labelTextLength,
    hasLeadingIcon = false,
  } = input;
  const horizontalGap = targetX - sourceX;
  const verticalSpan = Math.abs(targetY - sourceY);
  const iconExtraWidth = hasLeadingIcon ? 10 : 0;
  const estimatedWidth = Math.max(54, labelTextLength * 5.5 + 14 + iconExtraWidth);

  const inCardVerticalBand = verticalSpan < 104;
  const gapTooTight = horizontalGap < estimatedWidth + 8;

  if (inCardVerticalBand && gapTooTight) {
    const liftedY = Math.min(sourceY, targetY) - 62;
    const stemHeight = Math.max(0, labelY - liftedY - 12);
    return {
      x: labelX,
      y: liftedY,
      isOffset: true,
      stemHeight,
    };
  }

  return {
    x: labelX,
    y: labelY,
    isOffset: false,
    stemHeight: 0,
  };
}
