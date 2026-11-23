import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
await page.waitForSelector('input[type=email]', { timeout: 20000 });
await page.fill('input[type=email]', 'admin@1.com');
await page.fill('input[type=password]', 'Aa123456');
await page.click('button:has-text("登录并进入创作中心")');
await page.waitForTimeout(12000);
console.log('url', page.url());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 600));
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/login-after.png', timeout: 30000 });
await browser.close();
