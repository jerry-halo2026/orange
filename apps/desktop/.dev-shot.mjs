import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const pages = browser.contexts().flatMap((context) => context.pages());
console.log('pages', pages.length);
mkdirSync('../../../../.dev/shots', { recursive: true });
let index = 0;
for (const page of pages) {
  index += 1;
  console.log(index, page.url(), await page.title().catch(() => ''));
  await page.screenshot({ path: `../../.dev/shots/dev-${index}.png`, timeout: 30000 }).catch((error) => console.log('shot failed', error.message));
}
await browser.close();

