import type { BaseDocument } from "../core/documents";
export type RotationDocument = Pick<BaseDocument, "flags"> & {rotation?: number};
export const normalizeRotation = (angle: number): number => ((angle % 360) + 360) % 360;
export function rotationDuration(doc: RotationDocument): number | undefined {
  const hint=doc.flags.arenaRotation;
  if (!hint || typeof hint!=="object" || Array.isArray(hint) || hint.rotation !== (doc.rotation ?? 0)) return undefined;
  return typeof hint.durationMs==="number" && Number.isFinite(hint.durationMs) && hint.durationMs>=0 && hint.durationMs<=60000
    ? hint.durationMs : undefined;
}
/** Endpoint-only receipt-time presentation. Canonical endpoints use the shortest arc,
 * with a deterministic clockwise tie. No full-revolution or hidden-origin replay. */
export class RotationAnimation {
  private target: number | undefined;
  private hint: string | undefined;
  private run: {from:number;delta:number;at:number;duration:number} | undefined;
  update(doc: RotationDocument, now: number, cut=false): number {
    const to=normalizeRotation(Number.isFinite(doc.rotation) ? doc.rotation ?? 0 : 0);
    const from=this.sample(now);
    const hint=JSON.stringify(doc.flags.arenaRotation??null), fresh=hint!==this.hint;
    this.hint=hint;
    if (to!==this.target) {
      const duration=rotationDuration(doc);
      let delta=normalizeRotation(to-from);
      if(delta>180)delta-=360;
      this.run=this.target!==undefined && !cut && fresh && duration!==undefined && duration>0
        ? {from,delta,at:now,duration} : undefined;
      this.target=to;
    }
    if(cut)this.cancel();
    return this.sample(now);
  }
  sample(now:number):number {
    const run=this.run;
    if(!run)return this.target??0;
    const progress=Math.max(0,Math.min(1,(now-run.at)/run.duration));
    if(progress===1){this.run=undefined;return this.target??0;}
    return normalizeRotation(run.from+run.delta*progress);
  }
  cancel():void {this.run=undefined;}
}
