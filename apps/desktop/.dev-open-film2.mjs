import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const snapshot = async (label) => {
  console.log('---', label, page.url());
  console.log(JSON.stringify(await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter(Boolean),
    inputs: [...document.querySelectorAll('input')].map((i) => ({ type: i.type, placeholder: i.placeholder })),
    dialogs: [...document.querySelectorAll('[role=dialog]')].length,
  }))));
};
await snapshot('home');
const target = page.getByRole('button', { name: '新建项目' }).first();
console.log('count', await page.getByRole('button', { name: '新建项目' }).count());
await target.click().catch((error) => console.log('click failed', error.message));
await page.waitForTimeout(4000);
await snapshot('after click');
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/film2.png', timeout: 30000 });
await browser.close();
