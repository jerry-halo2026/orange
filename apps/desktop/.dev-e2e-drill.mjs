import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const failures = [];
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().includes('/api/materials/')) failures.push(`${response.status()} ${response.url().slice(0, 120)}`);
});
const clickText = (label) => page.evaluate((value) => {
  const target = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === value)
    ?? [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().includes(value));
  if (!target) return false;
  target.click();
  return true;
}, label);

if (!(await page.locator('[data-product-folder]').count())) {
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
}
console.log('root folders', await page.locator('[data-product-folder]').count(), 'covers', await page.locator('[data-product-folder] [data-cover], [data-product-folder] img').count());
await page.locator('[data-product-folder]').first().click();
await page.waitForTimeout(7000);
console.log('level', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'folders', await page.locator('[data-product-folder]').count());
await page.locator('[data-product-folder]').first().click();
await page.waitForTimeout(7000);
console.log('level2', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'folders', await page.locator('[data-product-folder]').count());
await page.locator('[data-product-folder]').first().click();
await page.waitForTimeout(9000);
console.log('level3', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'materials', await page.locator('[data-product-materials]').count(), 'cards', await page.locator('[data-material-card]').count());
console.log('failures', JSON.stringify(failures.slice(0, 6)));
await browser.close();
