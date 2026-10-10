# Image handling release gate: Pinterest live check

Source: `IMAGE_HANDLING_DESIGN.md` §6.9 and §8 (Phase 2 gate). Release notes must include the table below.

The sandbox used for development cannot reach `i.pinimg.com`, and it has no Firefox or Safari.
So this check has to be run on a machine with normal internet access.

## Procedure

1. Open the built app (`pnpm build` then serve `dist/`, or the deployed build) over HTTPS.
   The design asks for the check to run in an HTTPS context, because the CSP only allows HTTPS image URLs.
2. Find a Pinterest pin and use the browser's **Copy image address** command (not the pin page URL).
   The address should look like `https://i.pinimg.com/...`.
3. For each browser (Chromium, Firefox, Safari) and each mode (Store, Link):
   a. Paste the image address into the app's URL import, or drop the text onto a scene background.
   b. Choose the mode in the preview dialog (Store is the default; Link is opt-in).
   c. Record the outcome: loaded, or the generic failure message.
4. Also paste the pin page URL (`https://www.pinterest.com/pin/...`). Expected: the message
   "This is a Pinterest page, not an image. Copy the image address instead."
5. If a browser shows the generic CORS message, save the image and drop the file. That is the documented fallback.

## Results

| Browser | Version | Store: image address | Link: image address | Pin page link | Notes |
|---|---|---|---|---|---|
| Chromium |  |  |  |  |  |
| Firefox |  |  |  |  |  |
| Safari |  |  |  |  |  |

Outcome values: `loaded`, `generic CORS message`, `other error (describe)`.

## Notes

- Store mode reads the bytes in the GM browser. It needs `Access-Control-Allow-Origin` from the image host.
- Link mode makes each viewer's browser load the URL, so each player needs the same access.
- The app does not add a proxy, relay, or proxy setting. A proxied link is tested like any other link (§6.9).
