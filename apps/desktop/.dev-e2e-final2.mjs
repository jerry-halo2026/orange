import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const calls = [];
page.on('response', async (response) => {
  if (response.url().includes('/api/materials/list')) calls.push(`${response.status()} ${response.url().slice(0, 110)}`);
});
const reset = () => page.evaluate(() => {
  const crumb = [...document.querySelectorAll('[data-product-crumb] button')].find((button) => (button.textContent ?? '').trim() === '产品');
  crumb?.click();
  return Boolean(crumb);
});
if (await reset()) await page.waitForTimeout(3000);
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
await page.waitForTimeout(20000);
console.log('cards', await page.locator('[data-material-card]').count(), 'materials', await page.locator('[data-product-materials]').count());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-200).replace(/\n/g, '|'));
console.log('calls', JSON.stringify(calls.slice(-5), null, 1));
await browser.close();
