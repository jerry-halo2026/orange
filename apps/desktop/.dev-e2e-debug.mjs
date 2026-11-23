import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const calls = [];
page.on('response', (response) => {
  if (response.url().includes('/api/materials/list')) calls.push(`${response.status()} ${response.url().slice(0, 160)}`);
});
page.on('console', (message) => { if (message.type() === 'error') console.log('console', message.text().slice(0, 200)); });
for (let step = 0; step < 3; step++) {
  await page.locator('[data-product-folder]').first().click();
  await page.waitForTimeout(7000);
}
console.log('level', await page.locator('[data-product-folders]').getAttribute('data-level').catch(() => null));
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(-500).replace(/\n/g, '|'));
console.log('calls', JSON.stringify(calls.slice(-6), null, 1));
await browser.close();
