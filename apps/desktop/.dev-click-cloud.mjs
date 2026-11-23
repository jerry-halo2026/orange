import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const clicked = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('button')].filter((node) => (node.textContent ?? '').trim() === '云管家');
  boxes.forEach((node) => node.click());
  return boxes.length;
});
await page.waitForTimeout(6000);
console.log('clicked', clicked);
console.log('subitems', await page.evaluate(() => [...document.querySelectorAll('[data-cloud-subtab-item]')].map((node) => [node.getAttribute('data-cloud-subtab-item'), (node.textContent ?? '').trim()])));
console.log('subnav', await page.locator('[data-material-subnav]').count());
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 220).replace(/\n/g, '|'));
await browser.close();
