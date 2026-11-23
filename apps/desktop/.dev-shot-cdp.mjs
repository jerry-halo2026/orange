import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const session = await page.context().newCDPSession(page);
const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: false }).catch((error) => ({ error: error.message }));
if (shot?.data) {
  mkdirSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots', { recursive: true });
  writeFileSync('D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/products.jpg', Buffer.from(shot.data, 'base64'));
  console.log('shot', 'products.jpg');
} else {
  console.log('shot failed', JSON.stringify(shot).slice(0, 200));
}
await browser.close();
