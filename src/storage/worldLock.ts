/** Prevent two GM tabs in the same browser origin from writing the same world. */
export async function acquireWorldLock(worldId: string): Promise<() => void> {
  const locks = globalThis.navigator?.locks;
  // Node tests and older origins may have no Web Locks. No false lock guarantee there.
  if (!locks) return () => undefined;
  return new Promise<() => void>((resolve, reject) => {
    void locks.request(`arenastar:world:${worldId}`, { ifAvailable: true }, async lock => {
      if (!lock) {
        reject(new Error("This world is already open in another GM tab. Close it there before opening it here."));
        return;
      }
      await new Promise<void>(release => { resolve(release); });
    }).catch(reject);
  });
}
