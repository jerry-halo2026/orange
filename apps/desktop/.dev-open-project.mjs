import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const opened = await page.evaluate(() => {
  const hits = [...document.querySelectorAll('*')].filter((node) => (node.textContent ?? '').trim() === '未命名 6');
  for (const hit of hits) {
    const clickable = hit.closest('button, a, [role=button], [data-project-card], [tabindex]');
    if (clickable) { clickable.click(); return clickable.outerHTML.slice(0, 120); }
  }
  return null;
});
console.log('opened', opened);
await page.waitForTimeout(9000);
console.log('url', page.url());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n/g, '|'));
console.log('subnav', await page.locator('[data-material-subnav]').count());
await browser.close();
