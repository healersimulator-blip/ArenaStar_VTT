import { CODEX_BUILTIN_WIDGETS } from "../../core/campaignCodexWidgets";
import { registerWidget } from "./codexWidgetRegistry";
import CodexWidgetView from "./CodexWidgetView.svelte";

/** First-party declarative widgets share a read-only renderer contract. */
for (const definition of Object.values(CODEX_BUILTIN_WIDGETS)) {
  registerWidget(
    definition.type,
    definition.version,
    CodexWidgetView,
    definition.configSchema,
    definition.capabilities,
  );
}
