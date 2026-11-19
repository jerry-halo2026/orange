// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Qwen, with the person's own DashScope (阿里云百炼) key: `tts` and `asr`.
 *
 * Both go to DashScope's multimodal-generation endpoint — the same address, a different model and a different input
 * shape. Speech synthesis makes a file (it is downloaded here and lands in `assets/`); recognition gives a transcript,
 * and word timings when the model reports them.
 *
 * Region matters: a Beijing key does not work against the Singapore endpoint and the other way round (401). `QWEN_URL`
 * names the endpoint to use (`OPENFILM_QWEN_URL` through `serviceUrl`), so a person using another region sets it once.
 */
import { billedBy, needed, noBalance, serviceUrl } from './common.mjs';

const NAME = 'Qwen';
const DEFAULT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const TTS_MODEL = 'qwen3-tts-flash';
const ASR_MODEL = 'qwen3-asr-flash';
/** The voices offered for voice-over; DashScope's own ids. */
const VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Dylan'];
/** 本 provider 收的语音格式（契约里的 speechFormat）：mp3 → udio/mpeg。 */
const SPEECH_MIME = 'audio/mpeg';

/** The endpoint: `OPENFILM_QWEN_URL`, else DashScope's Beijing one. */
const endpoint = () => serviceUrl('QWEN', DEFAULT_URL);

/**
 * What an audio answer is: DashScope returns either `output.audio.url` (a file to download) or
 * `output.audio.data` (base64), depending on the model. Both are handled; anything else is a sentence.
 * @param {any} body
 */
export function audioOf(body) {
  const audio = body?.output?.audio;
  if (typeof audio?.url === 'string' && audio.url.startsWith('https://')) return { url: audio.url };
  if (typeof audio?.data === 'string' && audio.data.length) return { base64: audio.data };
  const said = body?.message ?? body?.code ?? body?.output?.finish_reason;
  throw new Error(`Qwen returned no audio${said ? `: ${said}` : '.'}`);
}

/**
 * Qwen's transcript → `{ text, words }`. `words` is only there when the model reports timings: no timing, no words
 * (a made-up timing is worse than none — captions fall back to a speaker's own word timings, then to even spacing).
 * @param {any} body
 */
export function transcriptOf(body) {
  let text = '';
  const words = [];
  const content = body?.output?.choices?.[0]?.message?.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string') text += part.text;
      /* some models answer with timed spans: `{ text, start_time, end_time }` in milliseconds */
      for (const span of Array.isArray(part?.words) ? part.words : []) {
        if (typeof span?.text !== 'string' || typeof span?.start_time !== 'number' || typeof span?.end_time !== 'number') continue;
        words.push({ token: span.text, start: span.start_time / 1000, end: span.end_time / 1000 });
      }
    }
  }
  text = text.trim();
  if (!text) throw new Error('Qwen returned no transcript.');
  return words.length ? { text, words } : { text };
}

/** @type {import('./contract.mjs').Provider} */
export default {
  id: 'qwen',
  name: NAME,
  env: 'QWEN_API_KEY',
  keysUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  billingUrl: 'https://bailian.console.aliyun.com/?expenditure=1',
  pricingUrl: 'https://help.aliyun.com/zh/model-studio/models',
  verbs: ['tts', 'asr', 'voice'],
  models: {
    tts: [{ id: TTS_MODEL, name: 'Qwen3 TTS Flash' }],
    voice: VOICES.map((id) => ({ id, name: id })),
    asr: [{ id: ASR_MODEL, name: 'Qwen3 ASR Flash' }],
  },
  speechFormat: 'mp3',
  checkKey(key) {
    if (!/^sk-[A-Za-z0-9]{8,}$/.test(String(key))) throw new Error('A DashScope key starts with sk- (阿里云百炼 → API-KEY).');
  },
  async run(verb, args, ctx) {
    if (verb !== 'tts' && verb !== 'asr') throw new Error(`${NAME} does not do ${verb}.`);
    const headers = { authorization: `Bearer ${ctx.key}`, 'content-type': 'application/json' };

    if (verb === 'tts') {
      const said = needed(args, 'text');
      const voice = typeof args.voice === 'string' && args.voice.trim() ? args.voice.trim() : VOICES[0];
      let response;
      try {
        response = await fetch(endpoint(), {
          method: 'POST', redirect: 'error', headers,
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]),
          body: JSON.stringify({ model: ctx.model ?? TTS_MODEL, input: { text: said, voice }, parameters: { language_type: 'Chinese' } }),
        });
      } catch { throw new Error('Qwen was interrupted or timed out. Not retried.'); }
      if (!response.ok) {
        if (response.status === 402) throw noBalance(NAME);
        if (response.status === 401) throw new Error('Qwen refused the key (401). A Beijing key does not work on the Singapore endpoint: check the region, or set OPENFILM_QWEN_URL.');
        const said2 = await response.text().catch(() => '');
        throw new Error(`Qwen HTTP ${response.status}${said2 ? `: ${said2.slice(0, 160)}` : ''}. Not retried.`);
      }
      const body = await response.json().catch(() => null);
      const audio = audioOf(body);
      let bytes;
      if (audio.base64) bytes = new Uint8Array(Buffer.from(audio.base64, 'base64'));
      else {
        const file = await fetch(/** @type {string} */ (audio.url), { redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) });
        if (!file.ok) throw new Error(`Qwen gave an audio address that answered ${file.status}.`);
        bytes = new Uint8Array(await file.arrayBuffer());
      }
      if (!bytes.length) throw new Error('Qwen returned an empty audio file.');
      const out = typeof args.out === 'string' && args.out.trim() ? args.out.trim() : `assets/${voice}-${Date.now()}.mp3`;
      return {
        files: [{ path: out, bytes }],
        index: [{ src: out, kind: 'sound', voice }],
        receipt: { voice, model: ctx.model ?? TTS_MODEL },
        cost: billedBy(NAME),
      };
    }

    /* asr: the recording goes as a data URL; DashScope answers with the text, and timings when it has them */
    const src = needed(args, 'src');
    const bytes = Buffer.from(await ctx.read(src));
    if (!bytes.length) throw new Error('Qwen cannot transcribe an empty recording.');
    const mime = SPEECH_MIME;
    let response;
    try {
      response = await fetch(endpoint(), {
        method: 'POST', redirect: 'error', headers,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]),
        body: JSON.stringify({
          model: ctx.model ?? ASR_MODEL,
          input: { messages: [{ role: 'user', content: [{ audio: `data:${mime};base64,${bytes.toString('base64')}` }] }] },
          parameters: { asr_options: { enable_lit: true, enable_itn: false } },
        }),
      });
    } catch { throw new Error('Qwen was interrupted or timed out. Not retried.'); }
    if (!response.ok) {
      if (response.status === 402) throw noBalance(NAME);
      if (response.status === 401) throw new Error('Qwen refused the key (401). Check the DashScope region (OPENFILM_QWEN_URL).');
      const said = await response.text().catch(() => '');
      throw new Error(`Qwen HTTP ${response.status}${said ? `: ${said.slice(0, 160)}` : ''}. Not retried.`);
    }
    const body = await response.json().catch(() => null);
    const transcript = transcriptOf(body);
    return {
      files: [],
      index: [/** @type {any} */ ({ src, kind: 'sound', text: transcript.text, words: transcript.words })],
      receipt: { model: ctx.model ?? ASR_MODEL, words: transcript.words?.length ?? 0 },
      cost: billedBy(NAME),
    };
  },
};
