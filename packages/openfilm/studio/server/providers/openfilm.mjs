// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The OrangeFilm account a computer is signed in to (`sign-in.mjs`): the key it gets is kept like a pasted one and is
 * what Studio's account panel and the desktop agent speak with (`account.mjs`, `GET /v1/agent/models`).
 *
 * **It no longer makes media.** The media proxy it used to be — running other providers' models with OpenFilm's keys
 * and billing the account's balance — is gone: every kind of media is made with the person's own key at the provider
 * they chose (Settings → Services), and what needs no key at all (搜索/元素库/素材检索) is served by OpenFilm's own
 * library instead. So this module declares no verbs and no models: it appears in no verb's provider list, is never
 * chosen to make anything, and `hideInServices` keeps it out of the services board.
 *
 * What it still carries, and why it must stay:
 *   · `env` + `keysUrl`/`billingUrl` — so `providerKey()` can find an `ofk_` key from the environment or Settings;
 *   · `signIn` — the account is connected by signing in on OpenFilm's site, not by pasting a key;
 *   · `checkKey` — a pasted key that is not an `ofk_` one is refused where it is pasted, not at the first run.
 *
 * @type {import('./contract.mjs').Provider & { hideInServices: true, accountOnly: true }}
 */
export default /** @type {any} */ ({
  id: 'openfilm',
  name: 'OrangeFilm',
  env: 'OPENFILM_API_KEY',
  keysUrl: 'https://openfilm.dev/account',
  billingUrl: 'https://openfilm.dev/account',
  signIn: {
    page: 'https://openfilm.dev/account/connect',
    token: 'https://openfilm.dev/api/connect/token',
    revoke: 'https://openfilm.dev/api/connect/revoke',
  },
  /* no media: an empty list, so nothing can be chosen to make anything with it */
  verbs: [],
  models: {},
  /* 不是"服务"，是账号：Settings → 服务 里不列这一行（providers/index.mjs 按这两个标记过滤） */
  accountOnly: true,
  hideInServices: true,
  checkKey(key) {
    if (!String(key).startsWith('ofk_')) {
      throw new Error('An OrangeFilm key starts with ofk_. Connect OrangeFilm instead of pasting a key here.');
    }
  },
  /* 这一行永远不会被调用：verbs 为空，没有任何动词会选中它（留一个会抛的实现，好过让调用方拿到 undefined） */
  async run(verb) {
    throw new Error(`OrangeFilm does not make ${verb}: choose a provider with the person's own key in Settings → Services.`);
  },
});
