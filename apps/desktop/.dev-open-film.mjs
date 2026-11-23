import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
await page.click('button:has-text("新建项目")').catch(() => {});
await page.waitForTimeout(9000);
console.log('url', page.url());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 900));
console.log('buttons', await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 40)));
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/film.png', timeout: 30000 });
await browser.close();
