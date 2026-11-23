import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/projects/'));
const click = (text) => page.evaluate((value) => {
  const node = [...document.querySelectorAll('button, [role=tab], [data-category]')].find((b) => (b.textContent ?? '').trim() === value)
    ?? [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes(value));
  node?.click();
  return Boolean(node);
}, text);
await click('素材');
await page.waitForTimeout(3000);
await click('模板');
await page.waitForTimeout(3000);
await click('口播');
await page.waitForTimeout(5000);
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-600).replace(/\n/g, '|'));
const shot = await (await page.context().newCDPSession(page)).send('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: false });
writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/talking-templates.jpg', Buffer.from(shot.data, 'base64'));
console.log('saved');
await browser.close();
