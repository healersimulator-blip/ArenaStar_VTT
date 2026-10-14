/** First-party workspace layouts. Local presentation preferences never change a world or role. */
export const WORKSPACE_UI_KEY = "arenastar.workspace-ui.v1";
export const WORKSPACE_PROFILES = ["modern", "foundry", "roll20"] as const;
export type WorkspaceProfile = (typeof WORKSPACE_PROFILES)[number];
export type WorkspaceScheme = "dark" | "light";
export interface WorkspaceUiPrefs {
  version: 1;
  profile: WorkspaceProfile;
  roll20Scheme: WorkspaceScheme;
  panels: Record<WorkspaceProfile, boolean>;
}
export const WORKSPACE_PROFILE_INFO = {
  modern: { name: "ArenaStar", label: "Modern", description: "Quiet, contextual, canvas first.",
    detail: "A compact command bar, focused tool groups and an optional content drawer." },
  foundry: { name: "Foundry v14", label: "Familiar workspace", description: "Scene controls, document tabs, macro dock.",
    detail: "A reference-based v14 tabletop layout. ArenaStar still supplies the rules, sheets and permissions." },
  roll20: { name: "Roll20", label: "Current tabletop", description: "Toolbox, layers, pages and a docked sidebar.",
    detail: "A reference-based current Roll20 layout, with light and dark appearance. Not the Roll20 service." },
} as const;
export function workspaceUiPrefs(value: unknown): WorkspaceUiPrefs {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const panels = raw.panels && typeof raw.panels === "object" ? raw.panels as Record<string, unknown> : {};
  return { version: 1,
    profile: (WORKSPACE_PROFILES as readonly unknown[]).includes(raw.profile) ? raw.profile as WorkspaceProfile : "modern",
    roll20Scheme: raw.roll20Scheme === "dark" ? "dark" : "light",
    // Every layout opens with its content dock showing chat, as a tabletop is expected to; the
    // collapse state is remembered per layout on this device (D-464).
    panels: { modern: typeof panels.modern === "boolean" ? panels.modern : true,
      foundry: typeof panels.foundry === "boolean" ? panels.foundry : true,
      roll20: typeof panels.roll20 === "boolean" ? panels.roll20 : true },
  };
}
export function workspaceToolInset(profile: WorkspaceProfile): number {
  return profile === "foundry" ? 106 : profile === "roll20" ? 60 : 64;
}
export function workspaceTabOrder(profile: WorkspaceProfile): readonly string[] {
  if (profile === "foundry") return ["chat", "combat", "scenes", "placeables", "actors", "images", "journals", "tables", "macros", "playlists", "compendia", "settings"];
  if (profile === "roll20") return ["chat", "images", "journals", "playlists", "macros", "compendia", "settings", "actors", "combat", "scenes", "tables", "placeables"];
  return ["chat", "actors", "scenes", "images", "journals", "combat", "tables", "playlists", "compendia", "placeables", "macros", "settings"];
}
export function workspaceTabLabel(profile: WorkspaceProfile, id: string): string {
  const labels: Record<string, string> = { chat: "Chat", combat: "Combat", scenes: "Scenes", images: "Art library",
    journals: "Journal", tables: "Tables", playlists: "Jukebox", actors: "Actors", compendia: "Compendium",
    placeables: "Placeables", macros: "Macros", settings: "Settings" };
  if (profile === "foundry") return ({ chat: "Chat messages", combat: "Combat encounters", actors: "Actors", tables: "Rollable tables", playlists: "Audio playlists", settings: "Game settings" } as Record<string,string>)[id] ?? labels[id] ?? id;
  if (profile === "roll20") return ({ scenes: "My pages", macros: "Collections", settings: "My settings" } as Record<string,string>)[id] ?? labels[id] ?? id;
  return labels[id] ?? id;
}
