const { execSync } = require('child_process');
const fs = require('fs');
const files = execSync('git grep -lz "packages/openfilm"', { encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean);
let changed = 0;
for (const file of files) {
  if (file.startsWith('docs/execution/') || file.includes('CHANGELOG')) continue;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replaceAll('packages/openfilm', 'packages/orangefilm');
  if (next !== text) { fs.writeFileSync(file, next); changed++; }
}
console.log({ changed, total: files.length });
