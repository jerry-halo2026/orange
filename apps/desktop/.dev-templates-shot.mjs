import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:4757'));
const click = (text) => page.evaluate((value) => {
  const node = [...document.querySelectorAll('button, [role=tab]')].find((b) => (b.textContent ?? '').trim() === value)
    ?? [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes(value));
  node?.click();
  return Boolean(node);
}, text);
await click('模板');
await page.waitForTimeout(4000);
await click('口播');
await page.waitForTimeout(4000);
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-500).replace(/\n/g, '|'));
const shot = await (await page.context().newCDPSession(page)).send('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: false });
writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/templates-talking.jpg', Buffer.from(shot.data, 'base64'));
console.log('shot saved');
await browser.close();
