import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
await page.waitForTimeout(5000);
if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('登录并进入'))?.click());
  await page.waitForTimeout(9000);
}
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '素材中心')?.click());
await page.waitForTimeout(6000);
console.log('titles', await page.locator('h2').allTextContents());
await page.fill('input[data-filter="search"]', '苹果');
await page.locator('form').first().evaluate((form) => form.requestSubmit());
await page.waitForTimeout(8000);
console.log('searchValues', await page.locator('input[data-filter="search"]').evaluateAll((nodes) => nodes.map((node) => node.value)));
console.log('cards', await page.locator('[data-material-card]').count());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 160).replace(/\n/g, '|'));
await browser.close();
