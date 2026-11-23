import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
console.log('subitems', await page.evaluate(() => [...document.querySelectorAll('[data-cloud-subtab-item]')].map((node) => [node.getAttribute('data-cloud-subtab-item'), node.textContent])));
await page.evaluate(() => document.querySelector('[data-cloud-subtab-item="products"]')?.click());
await page.waitForTimeout(10000);
console.log('folders', await page.locator('[data-product-folder]').count(), 'covers', await page.locator('[data-product-folder] img, [data-product-folder] [data-cover]').count());
const session = await page.context().newCDPSession(page);
const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: false });
writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/products-cloud.jpg', Buffer.from(shot.data, 'base64'));
console.log('shot saved');
await browser.close();
