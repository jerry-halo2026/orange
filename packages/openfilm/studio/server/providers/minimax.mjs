// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * MiniMax, with the person's own key: `tts`, `asr` and `music`.
 *
 * Three different services, three different shapes:
 *   · tts   `POST /v1/t2a_v2` — synchronous; the answer's `data.audio` is **hex**, not base64, and `data.status`
 *           says 1 while it is still synthesizing and 2 when it is done;
 *   · asr   `POST /v1/speech_to_text` — multipart, `asr-1.0`, answers `text` (and segments when `verbose_json`);
 *   · music `POST /v1/music_generation` — asked once; the answer carries audio (hex or a link) like tts.
 *
 * Music is **probed, not assumed**: MiniMax has retired older music models and closed the music API to new accounts.
 * When the service says so, the run stops with a sentence a person can act on — it does not retry, and it never lands
 * an empty file as if it had worked.
 */
import { billedBy, landing, needed, noBalance, serviceUrl } from './common.mjs';

const NAME = 'MiniMax';
const DEFAULT_URL = 'https://api.minimaxi.com';
const TTS_MODEL = 'speech-2.8-hd';
const ASR_MODEL = 'asr-1.0';
const MUSIC_MODEL = 'music-3.0';

/** The host: `OPENFILM_MINIMAX_URL`, else the mainland one. */
const endpoint = (/** @type {string} */ path) => `${serviceUrl('MINIMAX', DEFAULT_URL).replace(/\/+$/, '')}${path}`;

/**
 * `data.audio` is hex; some answers give a link instead. Either way, bytes come out of here or the run stops.
 * @param {any} body @param {string} what
 */
export function audioOf(body, what = 'audio') {
  const data = body?.data ?? body?.audio_file ?? body;
  const hex = data?.audio ?? data?.audio_hex;
  if (typeof hex === 'string' && hex.length > 1 && /^[0-9a-fA-F]+$/.test(hex)) return { hex };
  const url = data?.url ?? data?.audio_url;
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return { url };
  const said = body?.base_resp?.status_msg ?? body?.base_resp?.status_code ?? body?.message;
  throw new Error(`MiniMax returned no ${what}${said ? `: ${said}` : ''}. Not retried.`);
}

/** `data.status`: 1 = 合成中, 2 = 完成. Anything else is the service telling us something we must not ignore. */
export function statusOf(body) {
  const status = body?.data?.status;
  if (status === undefined || status === null) return 2;
  if (status === 2) return 2;
  if (status === 1) return 1;
  throw new Error(`MiniMax answered status ${status}: the audio was not made. Not retried.`);
}

/** The service's own error, in its own words (`base_resp.status_msg`), or the http status. */
function refusal(/** @type {Response} */ response, /** @type {any} */ body) {
  const message = body?.base_resp?.status_msg;
  const code = body?.base_resp?.status_code;
  if (typeof message === 'string' && message && !/^success$/i.test(message)) {
    return `${message}${code !== undefined ? ` (${code})` : ''}`;
  }
  return `HTTP ${response.status}`;
}

/** @type {import('./contract.mjs').Provider} */
export default {
  id: 'minimax',
  name: NAME,
  env: 'MINIMAX_API_KEY',
  keysUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  billingUrl: 'https://platform.minimaxi.com/user-center/basic-information',
  pricingUrl: 'https://platform.minimaxi.com/document/price',
  verbs: ['tts', 'asr', 'music'],
  models: {
    tts: [{ id: TTS_MODEL, name: 'Speech 2.8 HD' }],
    asr: [{ id: ASR_MODEL, name: 'ASR 1.0' }],
    music: [{ id: MUSIC_MODEL, name: 'Music 3.0' }],
  },
  speechFormat: 'mp3',
  checkKey(key) {
    /* 历史上的 MiniMax 接口还要 GroupId：允许 `groupId:apiKey`，运行时拆开（README 与 Settings 文案都这么写） */
    const text = String(key);
    const secret = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
    if (secret.trim().length < 16) throw new Error('A MiniMax key is the interface key (at least 16 characters), or groupId:apiKey on older accounts.');
  },
  async run(verb, args, ctx) {
    if (!['tts', 'asr', 'music'].includes(verb)) throw new Error(`${NAME} does not do ${verb}.`);
    /* `groupId:apiKey` on accounts that still need the group: the secret is what goes in the header */
    const raw = String(ctx.key ?? '');
    const key = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const groupId = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : '';
    const auth = { authorization: `Bearer ${key}`, ...(groupId ? { 'group-id': groupId } : {}) };

    if (verb === 'asr') {
      const src = needed(args, 'src');
      const bytes = Buffer.from(await ctx.read(src));
      if (bytes.length > 50_000_000) throw new Error('MiniMax takes recordings under 50 MB. Nothing was uploaded.');
      const form = new FormData();
      form.set('model', ctx.model ?? ASR_MODEL);
      form.set('file', new Blob([bytes], { type: 'audio/mpeg' }), src.split('/').pop() || 'speech.mp3');
      form.set('response_format', 'verbose_json');
      let response;
      try {
        response = await fetch(endpoint('/v1/speech_to_text'), {
          method: 'POST', redirect: 'error', headers: auth, body: form,
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]),
        });
      } catch { throw new Error('MiniMax was interrupted or timed out. Not retried.'); }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 402) throw noBalance(NAME);
        throw new Error(`MiniMax ${refusal(response, body)}. Not retried.`);
      }
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) throw new Error('MiniMax returned no transcript.');
      const words = Array.isArray(body?.segments)
        ? body.segments.filter((s) => s && typeof s.text === 'string' && typeof s.start === 'number' && typeof s.end === 'number')
          .map((s) => ({ token: s.text, start: s.start, end: s.end }))
        : [];
      return {
        files: [],
        index: [/** @type {any} */ ({ src, kind: 'sound', text, ...(words.length ? { words } : {}) })],
        receipt: { model: ctx.model ?? ASR_MODEL, words: words.length },
        cost: billedBy(NAME),
      };
    }

    const isMusic = verb === 'music';
    /* tts 说的是 	ext（朗读脚本），music 说的是 prompt（描述）：同一个位置，两个名字 */
    const prompt = needed(args, isMusic ? 'prompt' : 'text');
    const voice = typeof args.voice === 'string' && args.voice.trim() ? args.voice.trim() : 'female-shaonv';
    const seconds = typeof args.sec === 'number' ? Math.min(300, Math.max(10, Math.round(args.sec))) : 30;
    let response;
    try {
      response = await fetch(endpoint(isMusic ? '/v1/music_generation' : '/v1/t2a_v2'), {
        method: 'POST', redirect: 'error',
        headers: { ...auth, 'content-type': 'application/json' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(600_000)]),
        body: JSON.stringify(isMusic
          ? { model: ctx.model ?? MUSIC_MODEL, prompt, audio_setting: { format: 'mp3', sample_rate: 44100 } }
          : {
            model: ctx.model ?? TTS_MODEL, text: prompt, stream: false,
            voice_setting: { voice_id: voice },
            audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000 },
          }),
      });
    } catch { throw new Error('MiniMax was interrupted or timed out. Not retried.'); }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 402) throw noBalance(NAME);
      throw new Error(`MiniMax ${refusal(response, body)}. Not retried.`);
    }
    /* 退役/未开通是 200 里的 base_resp 或者 data.status，不是 http 错误 —— 两种都要说人话 */
    const status = statusOf(body);
    const audio = status === 1 ? audioOf(body, 'finished audio') : audioOf(body);
    let bytes;
    if (/** @type {any} */ (audio).hex) bytes = new Uint8Array(Buffer.from(/** @type {any} */ (audio).hex, 'hex'));
    else {
      const file = await fetch(/** @type {string} */ (/** @type {any} */ (audio).url), { redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]) });
      if (!file.ok) throw new Error(`MiniMax gave an audio address that answered ${file.status}.`);
      bytes = new Uint8Array(await file.arrayBuffer());
    }
    if (!bytes.length) throw new Error(`MiniMax returned an empty ${isMusic ? 'music' : 'voice'} file.`);
    /* `--out` 是名字不是路径（get.mjs 只收纯名）：配音落 `assets/audio/vo/`，音乐落 `assets/audio/music/`；
       直接把 out 当路径会让文件被跳过、`src` 指向项目外。 */
    const path = isMusic
      ? landing('audio/music', args.out, 'mp3')
      : landing('audio/vo', args.out, 'mp3');
    return {
      files: [{ path, bytes }],
      index: [/** @type {any} */ ({ src: path, kind: 'sound', ...(isMusic ? {} : { voice }) })],
      receipt: { model: ctx.model ?? (isMusic ? MUSIC_MODEL : TTS_MODEL), ...(isMusic ? {} : { voice }), seconds },
      cost: billedBy(NAME),
    };
  },
};
