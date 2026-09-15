import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry =
  "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

/**
 * M10 — hero melee, casting and direct targeting through normal player controls.
 *
 * The whole slice is "the engine already does this, the controls did not let a player ask
 * for it", so the browser test drives the real `ArmyWindow` component over a real
 * `ClientSync` replica and asserts the order documents that land — plus the capability gate
 * that keeps a non-PF1e campaign from showing controls it can only refuse.
 */
test.describe("M10 hero orders in the Army Management Window", () => {
  test("direct target + pack casting issue real orders; the demo module gets no caster", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { heroOrdersSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.heroOrdersSmoke()) as {
        ok: boolean;
        heroControls: boolean;
        targets: string[];
        undeployed: string;
        attackOrder: string;
        castOrder: string;
        attackLabel: string;
        basicTargetControl: boolean;
        basicCastControl: boolean;
        castOptions: string[];
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.heroControls).toBe(true);
    // The undeployed enemy artillery is named, not silently hidden.
    expect(result.targets).toEqual(["u-b-0"]);
    expect(result.undeployed).toContain("1");
    expect(result.attackOrder).toBe('{"kind":"attack","targetUnitId":"u-b-0"}');
    expect(result.castOrder).toBe(
      '{"kind":"custom","type":"spell_aoe","data":{"spell":"fireball","x":40,"y":12}}',
    );
    expect(result.attackLabel).toBe("attack → u-b-0");
    expect(result.castOptions).toContain("fireball");
    expect(result.castOptions).toContain("burning-hands");
    // The capability gates are independent: mass-battle-basic validates and executes
    // `attack` orders, so its direct-target control stays; it advertises no spell
    // vocabulary, so the caster control must not render.
    expect(result.basicTargetControl).toBe(true);
    expect(result.basicCastControl).toBe(false);
  });
});
