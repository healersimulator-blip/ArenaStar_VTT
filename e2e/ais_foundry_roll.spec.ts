import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AIS_IFRAME_CSP } from "../src/packages/aisModuleIframe";

// Test the production Roll component under the exact production CSP, in an opaque-origin frame.
test("Foundry Roll evaluates arithmetic and dice while unsafe-eval remains blocked", async ({
  page,
}) => {
  const source = readFileSync(
    new URL("../modules/ais-foundry-v13/runtime/roll.js", import.meta.url),
    "utf8",
  );
  const html = `<meta http-equiv="Content-Security-Policy" content="${AIS_IFRAME_CSP}"><body><script>
${source}
(async () => {
  try {
    let blocked = false;
    try { Function('return 123')(); } catch { blocked = true; }
    document.body.dataset.evalBlocked = String(blocked);
    const { Roll } = __aisFoundryRoll.install({clone: v => v, getProperty: () => 0, postMessage: async v => v});
    const arithmetic = await new Roll('2+3*4').evaluate();
    const dice = await new Roll('5d6').evaluate();
    document.body.dataset.arithmetic = String(arithmetic.total);
    document.body.dataset.diceCorrect = String(dice.total >= 5 && dice.total <= 30 &&
      dice.total === dice.dice[0].results.reduce((a,b) => a+b,0));
  } catch (error) { document.body.dataset.error = String(error); }
})();
</script>`;
  const escaped = html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  await page.setContent(
    `<iframe title="Roll sandbox" sandbox="allow-scripts" srcdoc="${escaped}"></iframe>`,
  );
  const body = page
    .frameLocator('iframe[title="Roll sandbox"]')
    .locator("body");
  await expect(body).toHaveAttribute("data-eval-blocked", "true");
  await expect(body).toHaveAttribute("data-arithmetic", "14");
  await expect(body).toHaveAttribute("data-dice-correct", "true");
  await expect(body).not.toHaveAttribute("data-error");
});
