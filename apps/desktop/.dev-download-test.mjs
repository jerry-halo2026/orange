import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const events = [];
page.on('response', async (response) => {
  if (response.url().includes('/api/materials/raw')) events.push({ status: response.status(), body: (await response.text().catch(() => '')).slice(0, 300) });
});
await page.waitForTimeout(3000);
if (await page.locator('input[type=email]').count()) {
  await page.fill('input[type=email]', 'admin@1.com');
  await page.fill('input[type=password]', 'Aa123456');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('登录并进入'))?.click());
  await page.waitForTimeout(10000);
}
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '素材中心')?.click());
await page.waitForTimeout(6000);
if (!(await page.locator('input[data-filter=search]').count())) {
  console.log('no material center', (await page.evaluate(() => document.body.innerText)).slice(0, 160).replace(/\n/g, '|'));
  await browser.close();
  process.exit(0);
}
await page.fill('input[data-filter=search]', '苹果');
await page.locator('form').first().evaluate((form) => form.requestSubmit());
await page.waitForTimeout(9000);
const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '下载');
  button?.click();
  return Boolean(button);
});
await page.waitForTimeout(18000);
console.log('clicked', clicked);
console.log('events', JSON.stringify(events.slice(0, 3)));
console.log('toast', (await page.evaluate(() => document.body.innerText)).slice(-300).replace(/\n/g, '|'));
await browser.close();
