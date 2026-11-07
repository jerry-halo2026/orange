export const studioChannels = {
  state: 'orange:studio:state',
  open: 'orange:studio:open',
  close: 'orange:studio:close',
} as const;

export const studioShellInset = 128 as const;

export type StudioState =
  | { kind: 'closed'; error: null | 'auth-required' | 'unavailable' | 'failed' }
  | { kind: 'opening' | 'open'; error: null };

export type DesktopStudioBridge = {
  getState(): Promise<StudioState>;
  open(): Promise<StudioState>;
  close(): Promise<StudioState>;
};

export function isStudioState(value: unknown): value is StudioState {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('error')) return false;
    const kindField = Object.getOwnPropertyDescriptor(value, 'kind');
    const errorField = Object.getOwnPropertyDescriptor(value, 'error');
    if (!kindField || !('value' in kindField) || !errorField || !('value' in errorField)) return false;
    const { kind, error } = value as Record<string, unknown>;
    return kind === 'closed'
      ? error === null || error === 'auth-required' || error === 'unavailable' || error === 'failed'
      : (kind === 'opening' || kind === 'open') && error === null;
  } catch {
    return false;
  }
}

export function isStudioInvocationArgs(value: unknown): value is readonly [] {
  try {
    return Array.isArray(value)
      && Object.getPrototypeOf(value) === Array.prototype
      && Reflect.ownKeys(value).length === 1
      && Object.getOwnPropertyDescriptor(value, 'length')?.value === 0
      && value.length === 0;
  } catch {
    return false;
  }
}
