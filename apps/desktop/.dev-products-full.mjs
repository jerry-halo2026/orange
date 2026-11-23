import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:4757'));
await page.reload().catch(() => {});
await page.waitForTimeout(8000);
if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('登录并进入'))?.click());
  await page.waitForTimeout(10000);
}
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '素材中心')?.click());
await page.waitForTimeout(6000);
await page.locator('[data-view-mode="products"]').first().click().catch(() => {});
await page.waitForTimeout(10000);
console.log('folders', await page.locator('[data-product-folder]').count(), 'levels', await page.locator('[data-product-level]').count());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n/g, '|'));
const shot = await (await page.context().newCDPSession(page)).send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: false });
writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/products-full.jpg', Buffer.from(shot.data, 'base64'));
console.log('saved');
await browser.close();
