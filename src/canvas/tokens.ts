/**
 * §9/§10 token layout math — TokenDocument (center x/y, pixel w/h) to the
 * top-left world rect Pixi sprites anchor at, plus selection math.
 */
import type { TokenDocument } from "../core/documents";

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Token x/y is the CENTER; Pixi containers anchor top-left. */
export function tokenRect(token: Pick<TokenDocument, "x" | "y" | "width" | "height">): WorldRect {
  return {
    x: token.x - token.width / 2,
    y: token.y - token.height / 2,
    width: token.width,
    height: token.height,
  };
}

/** Normalized marquee rect from two drag corners. */
export function marqueeRect(a: { x: number; y: number }, b: { x: number; y: number }): WorldRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Token center within marquee (hit test for rubber-band select). */
export function tokenInMarquee(
  token: Pick<TokenDocument, "x" | "y" | "width" | "height">,
  marquee: WorldRect,
): boolean {
  const rect = tokenRect(token);
  return (
    rect.x < marquee.x + marquee.width &&
    rect.x + rect.width > marquee.x &&
    rect.y < marquee.y + marquee.height &&
    rect.y + rect.height > marquee.y
  );
}

/** Disposition → border color (§9 convention). */
export function dispositionColor(disposition: TokenDocument["disposition"]): number {
  switch (disposition) {
    case "friendly":
      return 0x2e8b57; // sea green
    case "hostile":
      return 0xcd5c5c; // indian red
    case "neutral":
      return 0xb0b0b0; // gray
  }
}
