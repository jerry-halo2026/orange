import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const pages = browser.contexts().flatMap((context) => context.pages());
console.log('pages', pages.length);
mkdirSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots', { recursive: true });
for (const [index, page] of pages.entries()) {
  console.log(index, page.url(), await page.title().catch(() => ''));
  const info = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input')].map((input) => ({ type: input.type, name: input.name, placeholder: input.placeholder, value: input.value })),
    buttons: [...document.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim()).filter(Boolean).slice(0, 12),
    text: (document.body?.innerText ?? '').slice(0, 300),
  })).catch((error) => ({ error: error.message }));
  console.log(JSON.stringify(info));
  await page.screenshot({ path: `D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/dev-${index}.png`, timeout: 30000 }).catch((error) => console.log('shot failed', error.message));
}
await browser.close();
