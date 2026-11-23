import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const failures = [];
page.on('response', (response) => {
  if (response.status() >= 400 && response.url().includes('/api/materials/')) failures.push(`${response.status()} ${response.url()}`);
});
const clickText = (label) => page.evaluate((value) => {
  const target = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === value)
    ?? [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().includes(value));
  if (!target) return false;
  target.click();
  return true;
}, label);
const shot = (name) => page.screenshot({ path: `D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/${name}.png`, timeout: 90000, animations: 'disabled' });

if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await clickText('登录并进入创作中心');
  await page.waitForTimeout(10000);
}
console.log('after login', (await page.evaluate(() => document.body.innerText)).slice(0, 80).replace(/\n/g, '|'));
await clickText('素材中心');
await page.waitForTimeout(6000);
console.log('view modes', await page.locator('[data-view-mode]').count());
await page.locator('[data-view-mode="products"]').first().click().catch(() => {});
await page.waitForTimeout(9000);
const rootFolders = await page.locator('[data-product-folder]').count();
const levels = await page.locator('[data-product-level]').count();
const covers = await page.locator('[data-product-folder] [data-cover], [data-product-folder] img').count();
console.log(JSON.stringify({ rootFolders, levels, covers }));
await shot('products-root');
await page.locator('[data-product-folder]').first().click().catch((error) => console.log('folder click', error.message));
await page.waitForTimeout(7000);
console.log('level', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'folders', await page.locator('[data-product-folder]').count());
await page.locator('[data-product-folder]').first().click().catch((error) => console.log('product click', error.message));
await page.waitForTimeout(7000);
console.log('level2', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null), 'folders', await page.locator('[data-product-folder]').count());
await page.locator('[data-product-folder]').first().click().catch((error) => console.log('label click', error.message));
await page.waitForTimeout(9000);
console.log('materials', await page.locator('[data-product-materials]').count(), 'cards', await page.locator('[data-material-card], [data-entry-id]').count());
await shot('products-label-materials');
console.log('failures', JSON.stringify(failures.slice(0, 8)));
await browser.close();
