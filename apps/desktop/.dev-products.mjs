import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
await page.getByRole('button', { name: '打开素材中心' }).first().click();
await page.waitForTimeout(6000);
console.log('subnav', await page.locator('[data-material-subnav]').count());
console.log('tabs', await page.evaluate(() => [...document.querySelectorAll('[data-material-subnav] button')].map((b) => (b.textContent ?? '').trim())));
await page.locator('[data-material-subnav] button', { hasText: '产品' }).first().click().catch(async () => {
  await page.getByRole('button', { name: '产品' }).first().click();
});
await page.waitForTimeout(8000);
console.log('folders', await page.locator('[data-product-folder]').count());
console.log('levels', await page.evaluate(() => [...document.querySelectorAll('[data-product-level]')].map((n) => n.getAttribute('data-product-level'))));
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/products.png', timeout: 60000 }).catch((error) => console.log('shot failed', error.message));
await browser.close();
