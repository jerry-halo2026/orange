import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const failures = [];
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().includes('/api/materials/')) failures.push(`${response.status()} ${response.url().slice(0, 100)}`);
});
await page.reload().catch((error) => console.log('reload', error.message));
await page.waitForTimeout(8000);
const clickText = (label) => page.evaluate((value) => {
  const target = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === value);
  target?.click();
  return Boolean(target);
}, label);
if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await clickText('登录并进入创作中心');
  await page.waitForTimeout(10000);
}
await clickText('素材中心');
await page.waitForTimeout(6000);
await page.locator('[data-view-mode="products"]').first().click().catch(() => {});
await page.waitForTimeout(9000);
console.log('root folders', await page.locator('[data-product-folder]').count());
for (let step = 0; step < 3; step++) {
  await page.locator('[data-product-folder]').first().click();
  await page.waitForTimeout(6000);
  console.log('step', step + 1, 'level', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'folders', await page.locator('[data-product-folder]').count());
}
await page.waitForTimeout(4000);
console.log('materials', await page.locator('[data-product-materials]').count(), 'cards', await page.locator('[data-material-card]').count());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-160).replace(/\n/g, '|'));
console.log('failures', JSON.stringify(failures.slice(0, 6)));
await browser.close();
