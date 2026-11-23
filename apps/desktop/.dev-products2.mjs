import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const clickText = async (text) => page.evaluate((label) => {
  const target = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim().includes(label));
  if (!target) return false;
  target.click();
  return true;
}, text);
console.log('home text', (await page.evaluate(() => document.body.innerText)).slice(0, 120).replace(/\n/g, '|'));
console.log('open', await clickText('打开素材中心'));
await page.waitForTimeout(8000);
console.log('subnav', await page.locator('[data-material-subnav]').count());
console.log('nav buttons', await page.evaluate(() => [...document.querySelectorAll('[data-material-subnav] button')].map((b) => (b.textContent ?? '').trim())));
console.log('clicked product', await clickText('产品'));
await page.waitForTimeout(8000);
console.log('folders', await page.locator('[data-product-folder]').count());
console.log('levels', await page.evaluate(() => [...document.querySelectorAll('[data-product-level]')].map((n) => n.getAttribute('data-product-level')).slice(0, 8)));
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/products.png', timeout: 60000 }).catch((error) => console.log('shot failed', error.message));
await browser.close();
