/**
 * D-472: the world's active rules package on a *player* device.
 *
 * The host announces the active system package in every welcome (`sim.packageId/version`) and,
 * since D-472, where its `rules.js` can be fetched: `sim.artifact = { hash, size, name }`, a
 * content-addressed blob served on the §7 `assets` channel (32 KB chunks, resume, pacing) to any
 * approved session. This controller turns that announcement into an in-page `RulesModule` the
 * shell can hand to the same consumers the GM shell feeds from `HostApp.rulesModule` (D-471):
 * the army window's order validation and schema today, more as P3 proceeds.
 *
 * What differs from a shared AIS module (D-468) is the trust posture, and the prompt says so: a
 * rules package is **not sandboxed** — `importRulesModule` evaluates it in the page, with the
 * app's own authority. So nothing is fetched, let alone run, until this device allowed this
 * exact artifact for this world; the decision is remembered per device, world and package, and a
 * changed hash asks again ("updated"). The bytes are verified against the announced sha256 after
 * assembly (the asset cache stores by hash without checking), so neither a misbehaving host nor
 * a poisoned cache can substitute code under an allowed hash.
 *
 * Without consent (or before it) the shell behaves exactly as before D-472: built-in rules.
 *
 * D-473: an artifact whose hash is one of this build's own packages (`trusted`, wired to
 * `isFirstPartyArtifact`) loads without the prompt — it is the code this release used to carry
 * in its main bundle, now delivered by the world file; the status card says so.
 */
import type { ClientSync, ClientEvents } from "../client/sync";
import type { EventBus } from "../core/events";
import type { WelcomeRulesArtifact, WelcomeSimInfo } from "../core/messages";
import type { RulesModule } from "../core/rules";
import type { Result } from "../core/result";
import { err, okVal } from "../core/result";
import { sha256Hex } from "../host/assets";
import { importRulesModule } from "../sim/rulesLoader";
import { getSetting, putSetting, type IDBPDatabase } from "../storage/idb";

export const PLAYER_RULES_CONSENT_SCOPE_PREFIX = "rules-player-consent:";

export function playerRulesConsentScope(worldId: string): string {
  return `${PLAYER_RULES_CONSENT_SCOPE_PREFIX}${worldId}`;
}

export interface PlayerRulesConsentRecord {
  /** The artifact hash (sha256 of the bytes that run) this device decided on. */
  hash: string;
  decision: "allow" | "deny";
  at: number;
}

/** The announced package, as the shell's consent prompt and status card show it. */
export interface PlayerRulesOffer {
  packageId: string;
  name: string;
  version: string;
  hash: string;
  size: number;
  /** True when this device allowed an earlier artifact of the same package (an update, not a stranger). */
  updated: boolean;
  /** D-473: one of this build's own packages — loaded without a prompt, nothing to forget. */
  firstParty: boolean;
}

export type PlayerRulesStatus =
  /** No package announced (built-in rules), or none the host published an artifact for. */
  | { state: "none" }
  /** Announced; waiting for this device's decision. */
  | { state: "pending"; offer: PlayerRulesOffer }
  /** "Not now" remembered for this hash; the card offers a way back. */
  | { state: "declined"; offer: PlayerRulesOffer }
  | { state: "loading"; offer: PlayerRulesOffer }
  | { state: "ready"; offer: PlayerRulesOffer }
  | { state: "failed"; offer: PlayerRulesOffer; error: string };

export interface PlayerRulesPackageOptions {
  client: ClientSync;
  /** The client's event bus (PlayerApp.bus): `welcome` is where a (re-)announcement lands. */
  bus: EventBus<ClientEvents>;
  db: IDBPDatabase;
  worldId: string;
  /** Wired to `AssetFetcher.request(hash, "ui", "text/javascript")`. */
  fetch: (hash: string) => Promise<Uint8Array>;
  onStatus: (status: PlayerRulesStatus) => void;
  /** Test seam; production imports the verified source in-page. */
  importModule?: (source: string) => Promise<Result<RulesModule>>;
  /** D-473: is this artifact hash one of this build's own packages? Default: none is. */
  trusted?: (hash: string) => boolean;
  now?: () => number;
}

interface Announced {
  packageId: string;
  version: string;
  artifact: WelcomeRulesArtifact;
}

function announcedOf(info: WelcomeSimInfo | null): Announced | null {
  if (!info || info.packageId === null || !info.artifact) return null;
  const { hash, size, name } = info.artifact;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!Number.isSafeInteger(size) || size < 1) return null;
  return { packageId: info.packageId, version: info.version, artifact: { hash, size, name: typeof name === "string" ? name : info.packageId } };
}

async function defaultImport(source: string): Promise<Result<RulesModule>> {
  const loaded = await importRulesModule(source);
  return loaded.ok ? okVal(loaded.value.module) : err(loaded.error);
}

export class PlayerRulesPackage {
  private status: PlayerRulesStatus = { state: "none" };
  private current: Announced | null = null;
  private loaded: { hash: string; module: RulesModule } | null = null;
  /** Monotonic guard: a newer announcement or decision supersedes an in-flight load. */
  private epoch = 0;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly options: PlayerRulesPackageOptions) {
    this.unsubscribe = options.bus.on("welcome", () => { void this.announce(options.client.simInfo); });
    // The welcome may already have arrived (the shell starts us once the replica is live).
    void this.announce(options.client.simInfo);
  }

  /** The in-page module for the *currently announced* artifact, or null (→ built-in rules). */
  get module(): RulesModule | null {
    return this.loaded && this.current && this.loaded.hash === this.current.artifact.hash ? this.loaded.module : null;
  }

  get currentStatus(): PlayerRulesStatus {
    return this.status;
  }

  /** Allow the pending (or declined) artifact on this device: remembered, then fetched and loaded. */
  async allow(): Promise<void> {
    const offer = this.offerIf("pending", "declined", "failed");
    if (!offer) return;
    await this.writeConsent(offer.packageId, { hash: offer.hash, decision: "allow", at: this.now() });
    if (this.disposed || this.current?.artifact.hash !== offer.hash) return;
    await this.load(this.current, offer);
  }

  /** "Not now": remembered for this hash so the prompt does not return every session. */
  async deny(): Promise<void> {
    const offer = this.offerIf("pending");
    if (!offer) return;
    await this.writeConsent(offer.packageId, { hash: offer.hash, decision: "deny", at: this.now() });
    if (this.disposed || this.current?.artifact.hash !== offer.hash) return;
    this.set({ state: "declined", offer });
  }

  /** Withdraw this device's decision: the module is dropped and the prompt returns. */
  async forget(): Promise<void> {
    const offer = this.offerIf("ready", "declined", "failed", "loading");
    if (!offer || offer.firstParty) return;
    this.epoch += 1;
    await putSetting(this.options.db, { scope: playerRulesConsentScope(this.options.worldId), key: offer.packageId, value: null });
    if (this.disposed || this.current?.artifact.hash !== offer.hash) return;
    this.loaded = null;
    this.set({ state: "pending", offer: { ...offer, updated: false } });
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.unsubscribe();
  }

  private offerIf(...states: Array<PlayerRulesStatus["state"]>): PlayerRulesOffer | null {
    const status = this.status;
    return status.state !== "none" && states.includes(status.state) ? status.offer : null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private set(status: PlayerRulesStatus): void {
    if (this.disposed) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private async announce(info: WelcomeSimInfo | null): Promise<void> {
    if (this.disposed) return;
    const announced = announcedOf(info);
    const previous = this.current;
    if (announced === null) {
      this.current = null;
      this.epoch += 1;
      if (previous !== null || this.status.state !== "none") this.set({ state: "none" });
      return;
    }
    if (previous && previous.artifact.hash === announced.artifact.hash && previous.packageId === announced.packageId) return; // reconnect
    this.current = announced;
    const epoch = ++this.epoch;
    const firstParty = this.options.trusted?.(announced.artifact.hash) === true;
    const record = firstParty ? null : await this.consentRecord(announced.packageId);
    if (this.disposed || epoch !== this.epoch) return;
    const offer: PlayerRulesOffer = {
      packageId: announced.packageId,
      name: announced.artifact.name,
      version: announced.version,
      hash: announced.artifact.hash,
      size: announced.artifact.size,
      updated: record?.decision === "allow" && record.hash !== announced.artifact.hash,
      firstParty,
    };
    if (firstParty) { await this.load(announced, offer); return; }
    if (record?.decision === "allow" && record.hash === offer.hash) { await this.load(announced, offer); return; }
    if (record?.decision === "deny" && record.hash === offer.hash) { this.set({ state: "declined", offer }); return; }
    this.set({ state: "pending", offer });
  }

  private async load(announced: Announced, offer: PlayerRulesOffer): Promise<void> {
    if (this.loaded?.hash === announced.artifact.hash) { this.set({ state: "ready", offer }); return; }
    const epoch = ++this.epoch;
    this.set({ state: "loading", offer });
    try {
      const bytes = await this.options.fetch(announced.artifact.hash);
      if (this.disposed || epoch !== this.epoch) return;
      // Verify what will run against what was announced and allowed; the asset cache keys by
      // hash without checking, and the host could be lying.
      const digest = await sha256Hex(bytes);
      if (digest !== announced.artifact.hash) {
        throw new Error(`integrity: the delivered code (sha256 ${digest.slice(0, 16)}…) is not the announced artifact`);
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const imported = await (this.options.importModule ?? defaultImport)(source);
      if (this.disposed || epoch !== this.epoch) return;
      if (!imported.ok) throw new Error(imported.error);
      this.loaded = { hash: announced.artifact.hash, module: imported.value };
      this.set({ state: "ready", offer });
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      this.loaded = null;
      this.set({ state: "failed", offer, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async consentRecord(packageId: string): Promise<PlayerRulesConsentRecord | null> {
    const row = await getSetting(this.options.db, playerRulesConsentScope(this.options.worldId), packageId);
    const value = row?.value as Partial<PlayerRulesConsentRecord> | null | undefined;
    if (!value || typeof value.hash !== "string" || (value.decision !== "allow" && value.decision !== "deny")) return null;
    return { hash: value.hash, decision: value.decision, at: typeof value.at === "number" ? value.at : 0 };
  }

  private async writeConsent(packageId: string, record: PlayerRulesConsentRecord): Promise<void> {
    await putSetting(this.options.db, { scope: playerRulesConsentScope(this.options.worldId), key: packageId, value: { ...record } });
  }
}
