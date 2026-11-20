/** Test-only provisioning through the campaign HTTP API; never load a user's campaign or invite file. */
import { auditCompanies } from "./companyAudit";
import { randomUUID } from "node:crypto";
import { generatedScenario } from "../../services/strategic-room/src/scenario";
import { campaignProof } from "../../src/core/strategicRoom/protocol";
import { DocumentStore } from "../../src/core/store";
import { sceneDeployment } from "../../src/core/strategicRoom/campaignScene";
import { generateIdentity, signText } from "../../src/net/identity";

/** Exercise the very same empty-scene deployment as the GM panel (one 10×10 company per seat).
 * Contact/mixed benchmark rosters use a different ID convention, so only march/hold here. */
function freshCompanies(count: number, work: string) {
  if (work !== "march" && work !== "idle")
    throw Error(
      "Fresh GM companies support march or idle workloads in this probe.",
    );
  const store = new DocumentStore({
    meta: {
      worldId: "fixture",
      name: "Campaign",
      system: "pf1e",
      systemVersion: "1",
    },
  });
  return sceneDeployment(
    store,
    {
      _id: "field",
      type: "scene",
      name: "Fresh companies",
      ownership: { default: 1 },
      flags: { core: { scale: "strategic" } },
      system: {},
      active: true,
      img: null,
      width: 5000,
      height: 5000,
      darkness: 0,
      grid: {
        type: "square",
        size: 20,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddR",
      },
      tokens: [],
      walls: [],
      lights: [],
      drawings: [],
      templates: [],
      notes: [],
      tiles: [],
      sounds: [],
    },
    4242,
    count,
    100,
  );
}

export async function campaignFixture(
  origin: string,
  count: number,
  units: number,
  work: string,
) {
  const token = process.env.STRATEGIC_TEST_LAUNCH_KEY;
  if (new URL(origin).hostname !== "127.0.0.1" || !token)
    throw new Error("Use the disposable loopback campaign harness.");
  const id = randomUUID(),
    gm = await generateIdentity();
  async function request(
    action: "launch" | "finish",
    scenario?: ReturnType<typeof generatedScenario>,
  ) {
    const at = Date.now();
    const res = await fetch(`${origin}/api/campaign/${action}`, {
      method: "POST",
      redirect: "error",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id,
        publicKey: gm.publicKeyHex,
        at,
        signature: await signText(
          gm,
          campaignProof(action, origin, id, at, scenario),
        ),
        scenario,
      }),
    });
    if (!res.ok)
      throw new Error(`Campaign ${action} returned HTTP ${res.status}`);
    return res.json();
  }
  const scenario =
    units === 1
      ? freshCompanies(count, work)
      : generatedScenario(count, units, work);
  const { invites } = (await request("launch", scenario)) as {
    invites: Record<string, string>;
  };
  const roster = new Map(
    scenario.commanders.map((c) => [c.id, new Set(c.units.map((u) => u.id))]),
  );
  return {
    roster,
    audit: async (turns: number) => {
      if (units === 1) {
        const url = process.env.STRATEGIC_TEST_DATABASE_URL;
        if (
          !url ||
          !["127.0.0.1", "[::1]", "localhost"].includes(new URL(url).hostname)
        )
          throw Error(
            "Need disposable local database for checkpoint verification",
          );
        await auditCompanies(url, id, count, turns, work === "march");
      }
    },
    gm,
    invites,
    path: `/battle/${id}`,
    finish: () => request("finish"),
  };
}
