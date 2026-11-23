import { buildMaterialIndexFromApi, writeMaterialIndex } from '../../packages/openfilm/src/material-index-build.mjs';
import { fetchPageFromStudio } from '../../packages/openfilm/scripts/material-index-build.mjs';

const origin = 'http://127.0.0.1:4757';
const key = process.env.STUDIO_KEY;
const dir = process.env.APPDATA + '/OrangeFilm Dev/material-index';
const run = await buildMaterialIndexFromApi({
  fetchPage: fetchPageFromStudio({ origin, key, scope: 'company' }),
  pageSize: 100,
  videoTypes: [0, 1, 2, 3, 4],
  throttleMs: 1200,
});
await writeMaterialIndex(dir, run);
console.log('videos', run.videos, 'products', run.index.products?.length, 'batches', run.index.batches.length);
