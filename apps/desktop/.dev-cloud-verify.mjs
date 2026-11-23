import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
await page.waitForTimeout(8000);
if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('登录并进入'))?.click());
  await page.waitForTimeout(10000);
}
const opened = await page.evaluate(() => {
  const node = [...document.querySelectorAll('*')].find((item) => (item.textContent ?? '').trim().startsWith('未命名 7') && item.children.length === 0);
  if (!node) return false;
  const card = node.closest('[role=button], button, a, [tabindex], div');
  card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return Boolean(card);
});
await page.waitForTimeout(8000);
console.log('opened', opened, 'url', page.url());
const clicked = await page.evaluate(() => {
  const target = [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === '云管家');
  target?.click();
  return Boolean(target);
});
await page.waitForTimeout(5000);
console.log('clickedCloud', clicked);
console.log('subtabs', await page.evaluate(() => [...document.querySelectorAll('[data-cloud-subtab-item]')].map((node) => [node.getAttribute('data-cloud-subtab-item'), (node.textContent ?? '').trim(), node.getAttribute('aria-pressed')])));
console.log('folders', await page.locator('[data-product-folder]').count());
await browser.close();
