import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromDesktop = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode === 'main' || mode === 'preload') {
    const isMain = mode === 'main';
    const identity = isMain ? {
      appVersion: (JSON.parse(readFileSync(fromDesktop('./package.json'), 'utf8')) as { version: string }).version,
      buildCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fromDesktop('./'), encoding: 'utf8', timeout: 5_000, windowsHide: true,
      }).trim(),
    } : undefined;
    if (identity && (!/^[0-9a-f]{40}$/.test(identity.buildCommit) ||
      !/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){2}$/.test(identity.appVersion))) {
      throw new Error('Invalid desktop build identity');
    }
    return {
      define: identity ? {
        __ORANGE_BUILD_VERSION__: JSON.stringify(identity.appVersion),
        __ORANGE_BUILD_COMMIT__: JSON.stringify(identity.buildCommit),
      } : undefined,
      plugins: identity ? [{
        name: 'orange-desktop-build-identity',
        generateBundle(_options, bundle) {
          const main = bundle['index.js'];
          if (!main || main.type !== 'chunk') throw new Error('Desktop main bundle is missing');
          const mainSha256 = createHash('sha256').update(main.code).digest('hex');
          this.emitFile({ type: 'asset', fileName: 'build-identity.json',
            source: JSON.stringify({ ...identity, mainSha256 }) + '\n' });
        },
      }] : undefined,
      build: {
        target: 'node24',
        outDir: fromDesktop(`./dist/${mode}`),
        lib: {
          entry: fromDesktop(`./${mode}/index.ts`),
          formats: [isMain ? 'es' : 'cjs'],
          fileName: () => isMain ? 'index.js' : 'index.cjs',
        },
        rolldownOptions: { external: [/^node:/, 'electron'] },
      },
    };
  }

  return {
    root: fromDesktop('./renderer'),
    base: './',
    build: {
      outDir: fromDesktop('./dist/renderer'),
      // Only this directory is outside the renderer root.
      emptyOutDir: true,
    },
  };
});
