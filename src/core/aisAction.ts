/** Generic AIS attribution shared by kernel write services, never supplied by guest code. */
import type { ActionDescriptor } from "./actionRevert";

export function aisActionDescriptor(
  packageId: string | undefined,
  method: string,
): ActionDescriptor {
  return {
    label: (packageId ? `AIS ${packageId}: ${method}` : `AIS: ${method}`).slice(
      0,
      160,
    ),
    system: { aisModule: true, ...(packageId ? { packageId } : {}), method },
  };
}
