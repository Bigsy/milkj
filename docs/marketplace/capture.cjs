// Run with Vite serving frontend/ and Playwright available through NODE_PATH.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const out = __dirname;
const overview = `# A better home for your Markdown

Project notes, thoughtful READMEs, and the plan for what comes next.

## Release checklist

- [x] Write the getting-started guide
- [x] Document the configuration options
- [ ] Review the examples with the team

## Small details. Clear documentation.

Bring **important ideas** forward, add *a little emphasis*, and keep your \`code\` close to the explanation.

> Good documentation is part of the product.

## Project at a glance

| Area | Status | Next step |
| --- | --- | --- |
| Editor | Ready | Polish the examples |
| Documentation | In progress | Review the guide |
| Release | Planned | Share with the team |
`;
const diagrams = `# Make the architecture visible

Keep the diagram beside the explanation, in the same Markdown file.

## From idea to release

\`\`\`mermaid
flowchart LR
  A[Write Markdown] --> B[Review together]
  B --> C{Ready to ship?}
  C -->|Yes| D[Publish release]
  C -->|Refine| A
\`\`\`

## Code with context

\`\`\`kotlin
data class Release(val version: String, val ready: Boolean)

fun publish(release: Release) {
    require(release.ready) { "Review the checklist first" }
    println("Shipping " + release.version)
}
\`\`\`
`;
const writing = `# A clearer project guide

Good documentation helps everyone find their way.

## Getting started

Follow these steps to configure your workspace.

Keep the guide simple, accurate, and easy to follow.

## Before you publish

Review the documantation with your team.

A second look catches the small details that matter.

## Release checklist

- [x] Explain the setup process
- [x] Add examples for new contributors
- [ ] Review the final draft

## Further reading

Keep design notes and release plans close at hand.
`;
(async () => {
const browser = await chromium.launch({executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true});
try {
for(const [name, theme, markdown] of [['overview-dark','dark',overview],['overview-light','light',overview],['diagrams','dark',diagrams],['spelling-and-outline','dark',writing]]) {
 if (process.env.CAPTURE_ONLY && name !== process.env.CAPTURE_ONLY) continue;
 const page = await browser.newPage({viewport:{width:1200,height:1050},deviceScaleFactor:2});
 // Vite prebundling relocates Harper's relative WASM URL; serve the shipped binary.
 await page.context().route('**/harper_wasm_bg.wasm', route => route.fulfill({
   path:path.join(out,'../../frontend/node_modules/harper.js/dist/harper_wasm_bg.wasm'),
   contentType:'application/wasm',
 }));
 await page.goto(process.env.MILKJ_URL || 'http://127.0.0.1:5173/');
 await page.waitForFunction(()=>window.milkjSetMarkdown && document.querySelector('.ProseMirror'));
 await page.evaluate(({theme,markdown,name})=>{
 window.milkjApplyConfig({theme,configuredTheme:theme.toUpperCase(),editorTheme:'NORD',mermaidTheme:'AUTO',defaultEditor:'MILKJ',placeholder:'',proofingEnabled:name==='spelling-and-outline',proofingDialect:'AMERICAN',customDictionary:[],weirpacks:[]});
 window.milkjSetMarkdown(markdown,1);
 },{theme,markdown,name});
 await page.getByRole('heading',{level:1}).waitFor();
 if(name==='diagrams') await page.locator('.mermaid svg').waitFor({timeout:15000}).catch(()=>{});
 await page.evaluate(()=>document.fonts.ready);
 await page.waitForTimeout(1500);
 if(name==='spelling-and-outline') {
   await page.getByRole('button',{name:'Toggle outline'}).click();
   await page.getByRole('heading',{level:1}).click();
   const typo = page.locator('.milkj-proofing-issue').filter({hasText:'documantation'});
   await typo.waitFor({timeout:30000});
   await typo.click();
   await page.getByRole('dialog',{name:'Proofreading suggestion'}).waitFor();
 }
 await page.mouse.move(1195,1045);
 await page.screenshot({path:path.join(out,'../screenshots',name+'.png')});
 await page.close();
}
} finally { await browser.close(); }
})();
