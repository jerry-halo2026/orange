// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Which provider serves each verb of `orangefilm get`, and the API of Studio's Settings → Services.
 *
 * A person's own key for ElevenLabs, Inworld, Cartesia, OpenAI, Google (the Gemini API), fal.ai, OpenRouter, Groq, Microsoft Azure (Azure AI Speech), Pexels,
 * Pixabay, Brave Search, Tavily or OrangeFilm pays that service directly for what it can do. Each makes a kind of media with the model the person chose for
 * it (the provider's first unless they did). Keenable also works with no key: connected with one click, a key lifts its limits.
 * Who serves a verb: `--via <provider>` on the command, else the person's choice for that kind of media in Settings (`use`),
 * while it can; else nothing does. Every provider is treated alike: a kind with no choice goes to the first provider,
 * by name, that is connected and makes it (when one is connected, and when the one it had goes), and a choice the
 * person made is never changed.
 * Listing voices is part of voice-over: the provider that speaks finds the voices, so they never differ. Reading a web
 * page is part of web search the same way.
 */
import { HttpError, json, readJson } from '../http.mjs';
import { changeSettings, cleanKey, envKey, kindOf, modelFor, providerKey, readSettings } from '../keys.mjs';
import { shownService, withService } from '../custom-services.mjs';
import { cancelSignIn, signInState, signOut, startSignIn } from '../sign-in.mjs';
import elevenlabs from './elevenlabs.mjs';
import inworld from './inworld.mjs';
import cartesia from './cartesia.mjs';
import openai from './openai.mjs';
import google from './google.mjs';
import fal from './fal.mjs';
import openrouter from './openrouter.mjs';
import pexels from './pexels.mjs';
import pixabay from './pixabay.mjs';
import brave from './brave.mjs';
import tavily from './tavily.mjs';
import groq from './groq.mjs';
import azure from './azure.mjs';
import doubao from './doubao.mjs';
import qwen from './qwen.mjs';
import minimax from './minimax.mjs';
import mimo from './mimo.mjs';
import keenable from './keenable.mjs';
import orangefilm from './orangefilm.mjs';
import local from './local.mjs';
import { addedProblems, addedProviders } from './added.mjs';

/**
 * @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').Verb} Verb
 * @typedef {import('../keys.mjs').ProviderSettings} ProviderSettings
 * @typedef {import('../http.mjs').Req} Req @typedef {import('../http.mjs').Res} Res
 */

/** The providers paid with the person's own key, and Local services, which takes none. */
const BUILT_IN = [elevenlabs, inworld, cartesia, openai, google, fal, openrouter, pexels, pixabay, brave, tavily, groq, azure, doubao, qwen, minimax, mimo, keenable, orangefilm, local];
/** Those, then the ones the person added (added.mjs), as last read (changed in place). */
const OWN = [...BUILT_IN];

/** The kinds of media the person chooses a provider and model for (Settings → Services). */
const USE_VERBS = /** @type {Verb[]} */ (['tts', 'music', 'sfx', 'asr', 'cutout', 'image', 'image-search', 'video-search', 'video', 'translate', 'web-search']);

export const listProviders = () => OWN;

/**
 * The providers brought up to date: the ones the person added read again, and the models of those whose service says
 * what it offers (`refresh`).
 */
export async function freshProviders(/** @type {{ force?: boolean }} */ options = {}) {
  const added = await addedProviders(new Set(BUILT_IN.map((p) => p.id)));
  OWN.splice(BUILT_IN.length, OWN.length - BUILT_IN.length, ...added);
  await Promise.all(OWN.map((p) => p.refresh?.(options)));
  return OWN;
}

/**
 * The provider `id` when it can serve `verb` now. `strict` (asked for by name on the command): a sentence saying why
 * not, instead of null.
 * @param {string} id @param {Verb} verb @param {ProviderSettings} settings @param {boolean} strict
 */
async function named(id, verb, settings, strict) {
  const provider = OWN.find((p) => p.id === (id === 'orangefilm' ? 'orangefilm' : id));
  const fail = (/** @type {string} */ why) => { if (strict) throw new Error(why); return null; };
  if (!provider) return fail(`There is no provider "${id}": use ${OWN.map((p) => p.id).join(', ')}.`);
  if (provider.ready && !provider.verbs.includes(verb)) {
    return fail(`No local model for ${verb} is installed and on: the person installs one in Studio (the OrangeFilm logo at the top left opens Settings → Services → Local services).`);
  }
  if (!provider.verbs.includes(verb)) return fail(`${provider.name} does not do ${verb}.`);
  if (!providerKey(provider, settings)) {
    return fail(provider.keyless
      ? `${provider.name} is not connected: connect it in Studio (the OrangeFilm logo at the top left opens Settings → Services), no key needed, or set ${provider.env}.`
      : `There is no ${provider.name} key: add one in Studio (the OrangeFilm logo at the top left opens Settings → Services) or set ${provider.env}.`);
  }
  return provider;
}

/**
 * Each kind of media with no choice goes to the first provider, by name, that is connected and makes it (the header's
 * rule); the person's choices stay.
 * @param {ProviderSettings} s
 */
function fill(s) {
  const connected = OWN.filter((p) => providerKey(p, s)).sort((a, b) => a.name.localeCompare(b.name));
  for (const verb of USE_VERBS) {
    if (s.use[verb]) continue;
    const next = connected.find((p) => /** @type {readonly string[]} */ (p.verbs).includes(verb));
    if (next) s.use[verb] = next.id;
  }
}

/** The saved choices. */
export const providerSettings = () => readSettings();

/**
 * After a Local model came, went or was turned on or off: a kind it alone can make now goes to it, and a kind it can
 * no longer make goes to what else makes it (the header's rule). Written only when that changes something.
 */
export async function localModelsChanged() {
  await local.refresh?.();
  const settings = await readSettings();
  const before = JSON.stringify(settings.use);
  const next = structuredClone(settings);
  if (!providerKey(local, next)) for (const [verb, id] of Object.entries(next.use)) if (id === local.id) delete next.use[verb];
  for (const [verb, id] of Object.entries(next.use)) if (id === local.id && !local.verbs.includes(/** @type {Verb} */ (verb))) delete next.use[verb];
  fill(next);
  if (JSON.stringify(next.use) !== before) await changeSettings((s) => { s.use = next.use; });
}

/**
 * Who serves `verb`: `via` (a provider id from `--via`), else the person's choice while it can. null:
 * nothing is chosen, or what is chosen cannot serve now.
 * @param {Verb} verb @param {{ via?: string | null, settings?: ProviderSettings }} [options]
 * @returns {Promise<Provider | null>}
 */
export async function chooseProvider(verb, { via, settings } = {}) {
  const saved = settings ?? await providerSettings();
  /* every provider that speaks also lists its voices; one that searches the web reads its pages */
  const kind = /** @type {Verb} */ (kindOf(verb));
  /* what the one it would be offers now */
  await OWN.find((p) => p.id === (via || saved.use[kind]))?.refresh?.();
  if (via) return named(via, kind, saved, true);
  const chosen = saved.use[kind];
  if (!chosen) return null;
  return named(chosen, kind, saved, false);
}

/**
 * What each kind of media is made with, as Settings → Services shows it: the person's choice while its provider has a
 * key, else none. A choice whose key went away (an environment's key not set where Studio runs now) is kept in the
 * settings, and comes back with the key, but is not shown as if it could make anything.
 * @param {ProviderSettings} settings
 */
export function shownChoices(settings) {
  const live = (/** @type {string} */ verb) => {
    const provider = OWN.find((p) => p.id === settings.use[verb]);
    return provider && providerKey(provider, settings) ? provider : null;
  };
  return {
    use: Object.fromEntries(USE_VERBS.map((v) => [v, live(v)?.id ?? null])),
    /* the model each kind of media is made with, whoever makes it */
    model: Object.fromEntries(USE_VERBS.map((v) => {
      const provider = live(v);
      return [v, (provider && modelFor(settings, provider, v)) ?? null];
    })),
  };
}

/** Isolated desktop Services use only built-in metadata and the active account's local settings. */
const ISOLATED_BUILT_IN=BUILT_IN.map(p=>({...p,verbs:[...p.verbs],models:structuredClone(p.models??{})}));
/** @param {Provider} provider @param {ProviderSettings} settings */
function isolatedKey(provider,settings) {
  if(provider.id==='local')return null;
  const kept=settings.keys[provider.id];
  return kept?{key:kept,source:'file',env:provider.env}:provider.keyless&&kept===''?{key:'',source:'file',env:provider.env}:null;
}
/** @param {ProviderSettings} settings */
function isolatedFill(settings) {
  const connected=ISOLATED_BUILT_IN.filter(p=>isolatedKey(p,settings)).sort((a,b)=>a.name.localeCompare(b.name));
  for(const verb of USE_VERBS){if(settings.use[verb])continue;const provider=connected.find(p=>p.verbs.includes(verb));if(provider)settings.use[verb]=provider.id;}
}
async function isolatedState() {
  const settings=await readSettings();
  const chosen=(/** @type {string} */ verb)=>{const p=ISOLATED_BUILT_IN.find(row=>row.id===settings.use[verb]);return p&&isolatedKey(p,settings)?p:null;};
  return {
    limited:true,
    providers:ISOLATED_BUILT_IN.map(p=>{const key=isolatedKey(p,settings);return {
      id:p.id,name:p.name,verbs:p.verbs,models:p.models??{},keysUrl:p.keysUrl,pricingUrl:p.pricingUrl,env:p.env,envKey:false,
      ...(p.keyless?{keyless:true}:{}),configured:Boolean(key),source:key?.source??null,last4:key?.key?key.key.slice(-4):null,
      signIn:false,account:null,
    };}),
    signingIn:{provider:null,error:null,errorFor:null},
    use:Object.fromEntries(USE_VERBS.map(v=>[v,chosen(v)?.id??null])),
    model:Object.fromEntries(USE_VERBS.map(v=>{const p=chosen(v);return [v,(p&&modelFor(settings,p,v))??null];})),
    custom:settings.custom.map(shownService),librarySearch:settings.libraryOff?null:'local',
  };
}
/** @param {Req} req @param {Res} res @param {string[]} parts */
async function isolatedProvidersRoute(req,res,parts) {
  if(!parts.length&&req.method==='GET')return json(res,200,await isolatedState());
  if(parts[0]==='custom'&&parts.length<=2) {
    const id=parts[1]??null;
    if(id===null?req.method!=='POST':req.method!=='PUT'&&req.method!=='DELETE')throw new HttpError(405,'POST to add, PUT or DELETE one');
    const input=req.method==='DELETE'?{}:await readJson(req);
    await changeSettings(s=>{s.custom=req.method==='DELETE'?s.custom.filter(c=>c.id!==id):withService(s.custom,id,input);});
    return json(res,200,await isolatedState());
  }
  if(parts.length===2&&parts[1]==='key') {
    const provider=ISOLATED_BUILT_IN.find(p=>p.id===parts[0]);if(!provider)throw new HttpError(404,'no such provider');
    if(req.method==='PUT') {
      const body=await readJson(req);if(body.env===true)throw new HttpError(503,'Environment keys are unavailable in isolated development.');
      let key;try{key=provider.keyless&&body.key===''?'':cleanKey(body.key);if(key)provider.checkKey?.(key);}catch(e){throw new HttpError(400,/** @type {Error} */(e).message);}
      await changeSettings(s=>{s.keys[provider.id]=key;s.off=s.off.filter(id=>id!==provider.id);isolatedFill(s);});
      return json(res,200,await isolatedState());
    }
    if(req.method==='DELETE') {
      await changeSettings(s=>{delete s.keys[provider.id];delete s.accounts[provider.id];for(const [verb,id] of Object.entries(s.use))if(id===provider.id)delete s.use[verb];isolatedFill(s);});
      return json(res,200,await isolatedState());
    }
  }
  if(parts.length===1&&parts[0]==='library-search'&&req.method==='PUT') {
    const {on}=await readJson(req);if(typeof on!=='boolean')throw new HttpError(400,'on: true or false');
    await changeSettings(s=>{s.libraryOff=!on;});return json(res,200,await isolatedState());
  }
  if(parts.length===1&&parts[0]==='use'&&req.method==='PUT') {
    const {verb,provider,model}=await readJson(req),kind=USE_VERBS.find(v=>v===verb);
    if(!kind)throw new HttpError(400,'unknown media kind');
    const id=provider==null||provider===''?null:String(provider),found=ISOLATED_BUILT_IN.find(p=>p.id===id);
    if(id!==null&&(!found||!found.verbs.includes(kind)))throw new HttpError(400,'provider cannot make this media kind');
    const models=found?.models?.[kind]??[],named=model==null||model===''?null:models.find(m=>m.id===model);
    if(model!=null&&model!==''&&!named)throw new HttpError(400,'unknown model');
    await changeSettings(s=>{if(id===null)delete s.use[kind];else s.use[kind]=id;if(named&&named!==models[0])s.model[kind]=named.id;else delete s.model[kind];});
    return json(res,200,await isolatedState());
  }
  throw new HttpError(503,'This Services action is unavailable in isolated development.',{code:'isolation-capability-unavailable'});
}

/** What Settings → Services shows. Never a key: where it comes from and its last four characters. */
async function state() {
  await freshProviders();
  const settings = await readSettings();
  return {
    /* 账号（orangefilm）不是"服务"：它不出现在这块板子里，只在 providerKey / 登录那条路上被用到 */
    providers: OWN.filter((p) => !/** @type {any} */ (p).hideInServices).map((p) => {
      const key = providerKey(p, settings);
      /* `envKey`: the environment has one (connected or not), so connecting can use it */
      const inEnv = envKey(p);
      return {
        id: p.id, name: p.name, verbs: p.verbs, models: p.models ?? {}, keysUrl: p.keysUrl, pricingUrl: p.pricingUrl, env: key?.env ?? inEnv?.env ?? p.env, envKey: Boolean(inEnv),
        /* `keyless`: it connects without a key; connected so, it has no last four */
        ...(p.keyless ? { keyless: true } : {}), configured: Boolean(key), source: key?.source ?? null, last4: key?.key ? key.key.slice(-4) : null,
        /* connected by signing in (sign-in.mjs), and as whom */
        signIn: Boolean(p.signIn), account: key?.source === 'file' ? settings.accounts[p.id] ?? null : null,
        /* one the person added (added.mjs), not built in */
        ...(p.added ? { added: true } : {}),
      };
    }),
    /* the added services left out, and why */
    ...(addedProblems.size ? { addedProblems: [...addedProblems].map(([folder, problem]) => ({ folder, problem })) } : {}),
    signingIn: signInState(),
    ...shownChoices(settings),
    custom: settings.custom.map(shownService),
    /* the library searched by meaning at OrangeFilm's service, or by its words alone */
    librarySearch: settings.libraryOff ? null : 'local',
  };
}

/**
 * Studio's `/api/providers/*` (the editor page, with the launch key like the rest of the API). Each answers the state:
 *   GET    /api/providers           → { providers: [{ id, name, verbs, models: { verb: [{ id, name }] }, keysUrl, pricingUrl, env,
 *                                       keyless?, source: 'file' | 'env' | null, last4 }],
 *                                       use: { verb: provider id | null },
 *                                       model: { verb: model id | null },
 *                                       librarySearch: 'local' | null }
 *   PUT    /api/providers/:id/key   { key }               the key kept for that provider
 *   PUT    /api/providers/:id/key   { env: true }         the environment's key used for it again
 *   PUT    /api/providers/:id/key   { key: '' }           a keyless provider connected without a key
 *   DELETE /api/providers/:id/key                         disconnected: the kept key forgotten, the environment's
 *                                                         not used (until it is connected again)
 *   PUT    /api/providers/use       { verb, provider, model? }  who serves that kind of media (an id, or null: none),
 *                                       and with which of its models (its first when none is given)
 *   PUT    /api/providers/library-search { on }  the library searched by meaning at OrangeFilm's service (on, the
 *                                       default) or by its words alone
 *   POST   /api/providers/:id/billing → {}, the provider's own page for its balance opened in the person's browser
 *   POST   /api/providers/:id/sign-in         a provider with `signIn`: its website opened in the person's browser to
 *                                       sign in (sign-in.mjs); the state's `signingIn` says who is waiting, and why
 *                                       the last one failed; the key it gives is kept like a pasted one, with
 *                                       `account` (the email it is connected as)
 *   POST   /api/providers/:id/sign-in/cancel  the waiting sign-in dropped
 *   (DELETE /api/providers/:id/key signs a signed-in provider out: its key revoked there, then forgotten)
 *   POST   /api/providers/custom   { name, url, key?, auth?, note? }   one of the person's own services added
 *                                       (custom-services.mjs); the state has `custom: [{ id, name, url, auth, note,
 *                                       last4 }]`
 *   PUT    /api/providers/custom/:id  the same fields, changed (no `key`: kept as it is; '': none)
 *   DELETE /api/providers/custom/:id  taken away
 * @param {Req} req @param {Res} res @param {string[]} parts the path after /api/providers
 * @param {{ openBrowser: (url: string) => void, isolated?: boolean }} options
 */
export async function providersRoute(req, res, parts, { openBrowser, isolated = false }) {
  if(isolated)return isolatedProvidersRoute(req,res,parts);
  if (!parts.length && req.method === 'GET') return json(res, 200, await state());
  if (parts[0] === 'custom' && parts.length <= 2) {
    const id = parts[1] ?? null;
    if (id === null ? req.method !== 'POST' : req.method !== 'PUT' && req.method !== 'DELETE') throw new HttpError(405, 'POST to add, PUT or DELETE one');
    const input = req.method === 'DELETE' ? {} : /** @type {Record<string, unknown>} */ (await readJson(req));
    try {
      await changeSettings((s) => {
        s.custom = req.method === 'DELETE' ? s.custom.filter((c) => c.id !== id) : withService(s.custom, id, input);
      });
    } catch (e) {
      const status = /** @type {{ status?: number }} */ (e)?.status;
      if (status) throw new HttpError(status, /** @type {Error} */ (e).message);
      throw e;
    }
    return json(res, 200, await state());
  }
  if (parts.length === 2 && parts[1] === 'billing' && req.method === 'POST') {
    const provider = OWN.find((p) => p.id === (parts[0] === 'orangefilm' ? 'orangefilm' : parts[0]));
    if (!provider) throw new HttpError(404, 'no such provider');
    openBrowser(provider.billingUrl);
    return json(res, 200, {});
  }
  if (parts[1] === 'sign-in' && req.method === 'POST' && parts.length <= 3) {
    const provider = OWN.find((p) => p.id === (parts[0] === 'orangefilm' ? 'orangefilm' : parts[0]));
    if (!provider?.signIn) throw new HttpError(404, 'no such provider to sign in to');
    if (parts[2] === 'cancel') cancelSignIn();
    else if (parts.length === 2) {
      const id = provider.id;
      await startSignIn(/** @type {Provider & { signIn: NonNullable<Provider['signIn']> }} */ (provider), {
        openBrowser,
        done: async ({ key, email }) => {
          await provider.refresh?.({ force: true });
          await changeSettings((s) => {
            s.keys[id] = key;
            if (email) s.accounts[id] = email; else delete s.accounts[id];
            s.off = s.off.filter((x) => x !== id);
            fill(s);
          });
        },
      });
    } else throw new HttpError(404, 'no such API');
    return json(res, 200, await state());
  }
  if (parts.length === 2 && parts[1] === 'key') {
    const provider = OWN.find((p) => p.id === parts[0]);
    if (!provider) throw new HttpError(404, 'no such provider');
    if (req.method === 'PUT') {
      const body = /** @type {{ key?: unknown, env?: unknown }} */ (await readJson(req));
      const on = (/** @type {import('../keys.mjs').ProviderSettings} */ s) => { s.off = s.off.filter((id) => id !== provider.id); };
      if (body.env === true) {
        if (!envKey(provider)) throw new HttpError(400, `${provider.env} is not set here`);
        await provider.refresh?.();
        await changeSettings((s) => { on(s); fill(s); });
        return json(res, 200, await state());
      }
      let key;
      try { key = provider.keyless && body.key === '' ? '' : cleanKey(body.key); if (key) provider.checkKey?.(key); } catch (e) { throw new HttpError(400, /** @type {Error} */ (e).message); }
      await provider.refresh?.();
      await changeSettings((s) => { s.keys[provider.id] = key; on(s); fill(s); });
      return json(res, 200, await state());
    }
    if (req.method === 'DELETE') {
      const kept = (await readSettings()).keys[provider.id];
      if (provider.signIn && kept) await signOut(/** @type {Provider & { signIn: NonNullable<Provider['signIn']> }} */ (provider), kept);
      await changeSettings((s) => {
        delete s.keys[provider.id];
        delete s.accounts[provider.id];
        if (envKey(provider) && !s.off.includes(provider.id)) s.off.push(provider.id);
        /* what a provider that can no longer be used made goes to what else makes it */
        if (!providerKey(provider, s)) for (const [verb, id] of Object.entries(s.use)) if (id === provider.id) delete s.use[verb];
        fill(s);
      });
      return json(res, 200, await state());
    }
  }
  if (parts.length === 1 && parts[0] === 'library-search' && req.method === 'PUT') {
    const { on } = /** @type {{ on?: unknown }} */ (await readJson(req));
    if (typeof on !== 'boolean') throw new HttpError(400, 'on: true (OrangeFilm searches it by meaning) or false (by its words)');
    await changeSettings((s) => { s.libraryOff = !on; });
    return json(res, 200, await state());
  }
  if (parts.length === 1 && parts[0] === 'use' && req.method === 'PUT') {
    await freshProviders();
    const { verb, provider, model } = /** @type {{ verb?: unknown, provider?: unknown, model?: unknown }} */ (await readJson(req));
    const kind = USE_VERBS.find((v) => v === verb);
    if (!kind) throw new HttpError(400, `verb: one of ${USE_VERBS.join(', ')}`);
    const id = provider == null || provider === '' ? null : String(provider);
    if (id !== null && !OWN.some((p) => p.id === id && p.verbs.includes(kind))) throw new HttpError(400, `${id} cannot do ${kind}`);
    /* the provider's model, by id; its first unless one is given */
    const models = OWN.find((p) => p.id === id)?.models?.[kind] ?? [];
    const named = model == null || model === '' ? null : models.find((m) => m.id === model);
    if (model != null && model !== '' && !named) throw new HttpError(400, `${id ?? 'no provider'} has no model ${String(model)} for ${kind}`);
    await changeSettings((s) => {
      if (id === null) delete s.use[kind]; else s.use[kind] = id;
      if (named && named !== models[0]) s.model[kind] = named.id; else delete s.model[kind];
    });
    return json(res, 200, await state());
  }
  throw new HttpError(404, 'no such API');
}

