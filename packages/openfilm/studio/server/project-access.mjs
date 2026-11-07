const SESSION = ['environmentId', 'subjectId', 'instanceId', 'epoch', 'establishedAtMs', 'expiresAtMs'];
const IDENTITY = ['environmentId', 'subjectId', 'instanceId', 'epoch'];
const PROJECT = ['environmentId', 'ownerSubjectId', 'projectId', 'ownership', 'material'];

// Read each own data field once; never invoke evidence accessors or coerce values.
function snapshot(value, keys) {
  if (value === null || typeof value !== 'object') return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) return null;
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
const text = value => typeof value === 'string' && value.length > 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identityValid = value => value && text(value.environmentId) && text(value.subjectId) && text(value.instanceId) && Number.isSafeInteger(value.epoch) && value.epoch > 0;
const result = (allowed, reason, handle) => Object.freeze({allowed, reason, view:allowed && reason === 'allowed' ? 'retain' : 'lock-hide', recovery:'retain', ...(handle ? {handle} : {})});
const deny = reason => result(false, reason);
const opaque = () => Object.freeze({});

/**
 * Internal, in-memory policy only. Scalar evidence is NOT authentication or
 * ownership proof. A future trusted service must establish it online once;
 * neither this factory nor its mutators may be exposed to renderer/API callers.
 * Deadlines are absolute milliseconds in this process's monotonic clock domain.
 * This module does no persistence, saving, hiding, IO or authentication itself.
 */
export function createProjectAccessPolicy(sessionEvidence, options) {
  let phase = 'invalid-policy';
  let session;
  let clock;
  let lastNow;
  let sampling = false;
  const projects = new Map();
  const handles = new Map();
  let barrier;

  try {
    session = snapshot(sessionEvidence, SESSION);
    const settings = snapshot(options, ['monotonicNow']);
    if (identityValid(session) && time(session.establishedAtMs) && time(session.expiresAtMs) && typeof settings?.monotonicNow === 'function') {
      clock = settings.monotonicNow;
      lastNow = clock();
      if (time(lastNow) && session.establishedAtMs <= lastNow && lastNow < session.expiresAtMs) phase = 'active';
    }
  } catch { /* Invalid or hostile evidence yields an inert policy. */ }

  function tick() {
    if (phase !== 'active' && phase !== 'switching') return phase;
    if (sampling) { phase = 'clock-anomaly'; return phase; }
    sampling = true;
    try {
      const now = clock();
      if (phase !== 'active' && phase !== 'switching') return phase;
      if (!time(now) || now < lastNow) phase = 'clock-anomaly';
      else {
        lastNow = now;
        if (now >= session.expiresAtMs) phase = 'expired';
      }
    } catch { if (phase === 'active' || phase === 'switching') phase = 'clock-anomaly'; }
    finally { sampling = false; }
    return phase === 'active' || phase === 'switching' ? null : phase;
  }

  function contextError(input, withProject = false) {
    const context = snapshot(input, withProject ? [...IDENTITY, 'projectId'] : IDENTITY);
    if (phase !== 'active' && phase !== 'switching') return [phase];
    if (!identityValid(context) || (withProject && !text(context.projectId))) return ['invalid-input'];
    if (IDENTITY.some(key => context[key] !== session[key])) return ['identity-mismatch'];
    return [null, context];
  }

  function parseProject(input) {
    const evidence = snapshot(input, PROJECT);
    if (!evidence || !text(evidence.environmentId) || !text(evidence.ownerSubjectId) || !text(evidence.projectId) || !['controlled', 'unknown'].includes(evidence.ownership)) return ['invalid-input'];
    if (evidence.environmentId !== session.environmentId) return ['identity-mismatch'];
    if (evidence.ownership !== 'controlled') return ['ownership-unproven'];
    if (evidence.ownerSubjectId !== session.subjectId) return ['owner-mismatch'];
    let material;
    try {
      material = snapshot(evidence.material, ['kind']);
      if (material?.kind !== 'metadata-only') {
        material = snapshot(evidence.material, ['kind', 'expiresAtMs']);
        if (material?.kind !== 'applicable' || !time(material.expiresAtMs)) return ['material-required'];
      }
    } catch { return ['material-required']; }
    return [null, {...evidence, material}];
  }

  function sameProject(a, b) {
    return a.environmentId === b.environmentId && a.ownerSubjectId === b.ownerSubjectId && a.projectId === b.projectId && a.ownership === b.ownership && a.material.kind === b.material.kind && a.material.expiresAtMs === b.material.expiresAtMs;
  }
  const expired = evidence => evidence.material.kind === 'applicable' && lastNow >= evidence.material.expiresAtMs;

  // A hostile input can throw via proxy traps; public outcomes never carry it.
  const safe = operation => (...args) => {
    const terminal = tick();
    if (terminal) return deny(terminal);
    try { return operation(...args); }
    catch { return deny(phase !== 'active' && phase !== 'switching' ? phase : 'invalid-input'); }
  };

  return Object.freeze({
    bindProject:safe(input => {
      if (phase === 'switching') return deny('switching');
      const [error, evidence] = parseProject(input);
      if (phase !== 'active') return deny(phase);
      if (error) return deny(error);
      const previous = projects.get(evidence.projectId);
      if (previous && !sameProject(previous.evidence, evidence)) return deny('invalid-input');
      if (expired(evidence)) return deny('expired');
      if (previous) return result(true, 'allowed', previous.handle);
      const handle = opaque();
      projects.set(evidence.projectId, {evidence, handle});
      handles.set(handle, evidence);
      return result(true, 'allowed', handle);
    }),
    decide:safe((input, handle, access) => {
      if (phase === 'switching') return deny('switching');
      const [error, context] = contextError(input, true);
      if (phase !== 'active') return deny(phase);
      if (error) return deny(error);
      if (access !== 'metadata' && access !== 'restricted') return deny('invalid-input');
      const evidence = handles.get(handle);
      if (!evidence) return deny('unknown-project');
      if (context.projectId !== evidence.projectId) return deny('identity-mismatch');
      if (expired(evidence)) return deny('expired');
      if (access === 'restricted' && evidence.material.kind !== 'applicable') return deny('material-required');
      return result(true, 'allowed');
    }),
    revoke:safe(input => {
      const [error] = contextError(input);
      if (error) return deny(error);
      phase = 'revoked';
      return deny('revoked');
    }),
    beginSwitch:safe(input => {
      const [error] = contextError(input);
      if (error) return deny(error);
      if (phase === 'switching') return deny('switching');
      barrier = opaque();
      phase = 'switching';
      return result(true, 'allowed', barrier);
    }),
    completeSwitch:safe((input, handle) => {
      const [error] = contextError(input);
      if (error) return deny(error);
      if (phase !== 'switching' || handle !== barrier) return deny('switch-not-ready');
      if ([...projects.values()].some(({evidence}) => expired(evidence))) return deny('expired');
      barrier = undefined;
      phase = 'retired';
      // Success releases only A's barrier; A stays inaccessible. This is a
      // trusted completion notification, NOT proof of saving or authorization B.
      return result(true, 'retired');
    }),
    dispose() {
      tick();
      phase = 'disposed';
      barrier = undefined;
      handles.clear();
      projects.clear();
      return deny('disposed');
    },
  });
}
