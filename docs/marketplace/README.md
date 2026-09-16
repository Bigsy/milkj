# MilkJ Marketplace screenshots

Four 1920 × 1200 PNG cards, in upload order:

1. `01-visual-editing.png` — rich-text editing, tables, and task lists.
2. `02-diagrams-and-code.png` — Mermaid previews and Kotlin highlighting.
3. `03-light-and-dark.png` — light appearance and theme options.
4. `04-spelling-and-outline.png` — live spelling suggestions, custom dictionary action, and expanded document outline.

These capture the real MilkJ frontend running in Vite with sample documentation. The surrounding card and filename strip are presentation graphics, not IntelliJ chrome. No plugin code was changed. The cards have not been uploaded to Marketplace.

The visual direction follows the Seshlog cards: a dark gradient, subtle grid, feature headline, and framed capture. MilkJ uses its own icon and a quieter blue/teal palette.

## Regenerate

Requires Node, Playwright, and Google Chrome. Install Playwright in a temporary directory to avoid changing the plugin dependencies:

```sh
npm install --cache /tmp/milkj-npm-cache --prefix /tmp/milkj-capture playwright
```

Start `pnpm run dev --host 127.0.0.1` from `frontend/`, then from the repository root:

```sh
NODE_PATH=/tmp/milkj-capture/node_modules node docs/marketplace/capture.cjs
NODE_PATH=/tmp/milkj-capture/node_modules node docs/marketplace/generate.cjs
```

Override `CHROME` for another Chrome executable and `MILKJ_URL` if Vite uses a different address. Sample Markdown and capture configuration live in `capture.cjs`; copy and presentation styles live in `generate.cjs`. Raw captures are in `docs/screenshots/`. The generator also writes self-contained HTML previews beside the PNGs.

To refresh only the spelling capture, set `CAPTURE_ONLY=spelling-and-outline` when running `capture.cjs`. The harness activates the editor before waiting for Harper and serves the bundled WASM binary at its development URL. The outline is shown in its actual position on the left.
