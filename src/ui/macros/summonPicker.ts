export interface SummonPickOptions {
  sceneId: string;
  size?: number;
  maxDistance: number;
  requireLoS?: boolean;
  summonerTokenId?: string;
  /** A GM may explicitly place without a caster (range/LOS exemption). */
  gmManual?: boolean;
}
export type SummonPickPoint = { x: number; y: number };
/** UI-only, cancellable crosshair contract. Host still checks all mechanical rules. */
export type RequestSummonPick = (options: SummonPickOptions) => Promise<SummonPickPoint | null>;
