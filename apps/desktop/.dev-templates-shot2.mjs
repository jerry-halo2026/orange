import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:4757'));
const opened = await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((el) => (el.textContent ?? '').trim() === '未命名 7' && el.children.length === 0);
  const card = node?.closest('[data-project-card], button, [role=button], div');
  card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  card?.click();
  return Boolean(card);
});
await page.waitForTimeout(9000);
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '模板')?.click());
await page.waitForTimeout(3000);
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '口播')?.click());
await page.waitForTimeout(4000);
console.log('opened', opened, 'url', page.url());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-400).replace(/\n/g, '|'));
const shot = await (await page.context().newCDPSession(page)).send('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: false });
writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/templates-talking.jpg', Buffer.from(shot.data, 'base64'));
console.log('shot saved');
await browser.close();
