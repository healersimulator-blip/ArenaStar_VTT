import { writable, get } from "svelte/store";
import { WORKSPACE_UI_KEY, workspaceUiPrefs, type WorkspaceProfile, type WorkspaceScheme } from "../../core/workspaceUi";
function read() {
  try { return workspaceUiPrefs(JSON.parse(globalThis.localStorage?.getItem(WORKSPACE_UI_KEY) ?? "null")); }
  catch { return workspaceUiPrefs(null); }
}
export const workspaceUi = writable(read());
function save(): void {
  try { globalThis.localStorage?.setItem(WORKSPACE_UI_KEY, JSON.stringify(get(workspaceUi))); }
  catch { /* Presentation still works when device storage is denied. Never write to the world. */ }
}
export function setWorkspaceProfile(profile: WorkspaceProfile): void {
  workspaceUi.update((current) => workspaceUiPrefs({ ...current, profile })); save();
}
export function setWorkspaceScheme(roll20Scheme: WorkspaceScheme): void {
  workspaceUi.update((current) => ({ ...current, roll20Scheme })); save();
}
export function setWorkspacePanel(open: boolean): void {
  workspaceUi.update((current) => ({ ...current, panels: { ...current.panels, [current.profile]: open } })); save();
}
export function toggleWorkspacePanel(): void { const current = get(workspaceUi); setWorkspacePanel(!current.panels[current.profile]); }
export function resetWorkspaceUi(): void { workspaceUi.set(workspaceUiPrefs(null)); save(); }
