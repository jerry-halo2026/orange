import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const calls = [];
page.on('response', (response) => {
  if (response.url().includes('/api/materials/list')) calls.push(`${response.status()} ${response.url().slice(0, 150)}`);
});
const reset = () => page.evaluate(() => {
  const crumb = [...document.querySelectorAll('[data-product-crumb] button')].find((button) => (button.textContent ?? '').trim() === '产品');
  if (crumb) { crumb.click(); return true; }
  return false;
});
if (await reset()) await page.waitForTimeout(3000);
if (!(await page.locator('[data-product-folder]').count())) {
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === '素材中心');
    target?.click();
  });
  await page.waitForTimeout(5000);
  await page.locator('[data-view-mode="products"]').first().click().catch(() => {});
  await page.waitForTimeout(8000);
}
for (let step = 0; step < 3; step++) {
  await page.locator('[data-product-folder]').first().click();
  await page.waitForTimeout(6000);
}
console.log('level', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null));
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-400).replace(/\n/g, '|'));
console.log('calls', JSON.stringify(calls.slice(-5), null, 1));
await browser.close();
