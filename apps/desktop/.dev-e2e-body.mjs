import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
let body = null;
page.on('response', async (response) => {
  if (!body && response.url().includes('/api/materials/list') && response.url().includes('videoIds=')) {
    body = { status: response.status(), url: response.url(), json: await response.json().catch(() => null) };
  }
});
await page.evaluate(() => {
  const crumb = [...document.querySelectorAll('[data-product-crumb] button')].find((button) => (button.textContent ?? '').trim() === '产品');
  crumb?.click();
});
await page.waitForTimeout(3000);
if (!(await page.locator('[data-product-folder]').count())) {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === '素材中心')?.click());
  await page.waitForTimeout(5000);
  await page.locator('[data-view-mode="products"]').first().click().catch(() => {});
  await page.waitForTimeout(8000);
}
for (let step = 0; step < 3; step++) {
  await page.locator('[data-product-folder]').first().click();
  await page.waitForTimeout(6000);
}
await page.waitForTimeout(2000);
const picked = body;
console.log('body', JSON.stringify(picked ? { status: picked.status, url: picked.url.slice(0, 160), total: picked.json?.total, items: picked.json?.items?.length, filtered: picked.json?.filtered } : null));
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-160).replace(/\n/g, '|'));
await browser.close();
