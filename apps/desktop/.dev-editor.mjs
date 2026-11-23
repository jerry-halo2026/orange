import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((context) => context.pages())[0];
const clickText = async (text, selector = 'button, [role=button], [data-project-card]') => page.evaluate(([label, sel]) => {
  const nodes = [...document.querySelectorAll(sel)];
  const target = nodes.find((node) => (node.textContent ?? '').trim().includes(label));
  if (!target) return false;
  target.click();
  return true;
}, [text, selector]);
console.log('open project', await clickText('未命名 6'));
await page.waitForTimeout(9000);
console.log('text', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n/g, '|'));
console.log('tabs', await page.evaluate(() => [...document.querySelectorAll('[role=tab], [data-scope-tab], button')].map((b) => (b.textContent ?? '').trim()).filter((t) => t).slice(0, 30)));
await page.screenshot({ path: 'D:/dev/orange/.agents/worktrees/dsh-68d45102-2b0a/.dev/shots/editor.png', timeout: 60000 }).catch((error) => console.log('shot failed', error.message));
await browser.close();
