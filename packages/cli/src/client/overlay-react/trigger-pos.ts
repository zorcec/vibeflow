/**
 * Pure utilities for the corner-trigger button position.
 * No browser or React dependencies — safe to unit-test in Node.js.
 */

/**
 * Clamps a saved trigger position to viewport bounds so the button is always
 * visible — even when the position was saved on a larger monitor.
 *
 * @param pos      - Saved { x, y } position from localStorage
 * @param viewport - Current viewport { width, height }
 * @returns Clamped position guaranteed to be on-screen with an 8px margin
 */
export function clampTriggerPos(
  pos: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = Math.max(8, Math.min(viewport.width - 64, pos.x));
  const y = Math.max(8, Math.min(viewport.height - 64, pos.y));
  return { x, y };
}
