// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 本机的嵌入模型：bge-base-zh-v1.5（768 维，ONNX，onnxruntime-web/wasm）。
 *
 * 全产品只有这一个模型 —— 素材检索与元素库检索都用它，所以查询向量、素材向量、元素向量在同一个空间里。
 * 之前元素库用的是 multilingual-e5-small（384 维）外加一个服务端 `/v1/library/search`；换掉的原因是
 * "两套模型 → 两份下载 → 两个空间"，而实测 bge-base-zh 在中文上更强（素材 200 题 recall@20 90.5%）。
 *
 * 三件容易错、错了又不报错的事：
 *   - **池化**：BERT 系取第一个 token（`<s>`/CLS），不是 e5 的平均（用错余弦只有 0.749，而且不报错）；
 *   - **分词**：bge-*-zh 是 WordPiece（`./wordpiece.mjs`），不是 SentencePiece unigram；
 *   - **维度**：768 是原生宽度，不截断（它不是 MRL 模型）。
 *
 * 模型在哪找（按客户端装好之后的顺序）：
 *   1. 显式给的 `modelDir`（测试 / 非常规布局）—— 给了就不回落，配置写错要立刻看出来；
 *   2. `<shared home>/runtime/models/bge-base-zh-v1.5`（`ensureEmbedModel` 的落点，客户端走这条）；
 *   3. `library/models/bge-base-zh-onnx`（开发检出 / 安装包自带）。
 *
 * 加载一次、进程内复用；查询向量按 `model + query` 缓存（同一句话在 Studio 里会被反复问）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { sharedHome } from './locations.mjs';

/** 模型 id（也是向量空间的标签：换模型就是换空间）。 */
export const LOCAL_EMBED_MODEL = 'bge-base-zh-v1.5';
/** 模型在 `library/` 下的目录（开发检出 / 安装包自带的那一份）。 */
export const LOCAL_EMBED_DIR = 'models/bge-base-zh-onnx';
/** onnxruntime-web 的入口（同一个 wasm 运行时也跑着本地 ASR 与抠像）。 */
export const LOCAL_EMBED_RUNTIME = 'models/onnxruntime-web-1.31.1/ort.wasm.min.mjs';
/** 向量维度。 */
export const LOCAL_EMBED_DIMS = 768;

/**
 * 一个本机嵌入器：`(text) => Promise<number[]>`，长度 768、已归一化。
 *
 * 文件不在、ONNX 起不来 → 抛 `embed-unavailable` / `embed-failed`；调用方据此退到词法检索。
 *
 * @param {{ modelDir?: string, runtime?: string, cacheSize?: number }} [options]
 * @returns {(query: string) => Promise<number[]>}
 */
export function createLocalEmbedder({ modelDir, runtime, cacheSize = 256 } = {}) {
  /** @type {Promise<(text: string) => Promise<Float32Array>> | null} */
  let loading = null;
  /** @type {Map<string, number[]>} */
  const cache = new Map();
  const limit = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 0;
  const dir = typeof modelDir === 'string' && modelDir.trim() ? modelDir.trim() : '';
  const runtimeFile = typeof runtime === 'string' && runtime.trim() ? runtime.trim() : '';

  const load = () => {
    if (!loading) {
      loading = (async () => {
        /** @type {string} */
        let root = '';
        try {
          const { builtInRoot } = await import('../studio/server/library.mjs');
          root = builtInRoot();
        } catch {
          root = '';
        }
        const at = (/** @type {string} */ rel) => (root ? join(root, rel) : rel);
        const usable = (/** @type {string} */ candidate) => {
          try { return existsSync(join(candidate, 'tokenizer.json')); } catch { return false; }
        };
        const downloaded = join(sharedHome(), 'runtime', 'models', LOCAL_EMBED_MODEL);
        const folder = dir ? dir : (usable(downloaded) ? downloaded : at(LOCAL_EMBED_DIR));
        const runtimeCandidate = runtimeFile || (existsSync(join(folder, 'runtime', 'ort.wasm.min.mjs'))
          ? join(folder, 'runtime', 'ort.wasm.min.mjs')
          : at(LOCAL_EMBED_RUNTIME));
        const { loadEmbedder } = await import('./sentence-model.mjs');
        const { readWordPiece, tokenizeWordPiece } = await import('./wordpiece.mjs');
        const vocab = readWordPiece(join(folder, 'tokenizer.json'));
        return loadEmbedder({
          runtime: runtimeCandidate,
          onnx: join(folder, 'model_quantized.onnx'),
          pooling: 'cls',
          tokenize: (/** @type {string} */ text) => tokenizeWordPiece(vocab, text),
        });
      })().catch((error) => {
        loading = null;
        throw Object.assign(new Error(`the local model did not load: ${String(error?.message ?? error)}`), { code: 'embed-unavailable' });
      });
    }
    return loading;
  };

  return async (/** @type {string} */ query) => {
    const key = `${LOCAL_EMBED_MODEL}\u0000${query}`;
    if (limit > 0) {
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
    }
    const embed = await load();
    /** @type {Float32Array} */
    let vector;
    try {
      vector = await embed(query);
    } catch (error) {
      throw Object.assign(new Error(`the local model did not answer: ${String(error?.message ?? error)}`), { code: 'embed-failed' });
    }
    const numbers = Array.from(vector);
    if (numbers.length !== LOCAL_EMBED_DIMS) {
      throw Object.assign(new Error(`the local model returned ${numbers.length} dimensions, expected ${LOCAL_EMBED_DIMS}`), { code: 'embed-invalid' });
    }
    if (limit > 0) {
      cache.set(key, numbers);
      if (cache.size > limit) {
        /* `keys().next().value` is typed `string | undefined`; the cache is non-empty here, so the key exists. */
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return numbers;
  };
}
