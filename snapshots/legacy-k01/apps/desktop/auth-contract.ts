export const authChannels = {
  state: 'orange:auth:state',
  signIn: 'orange:auth:sign-in',
  signOut: 'orange:auth:sign-out',
} as const;

export type AuthState = { kind: 'unavailable' | 'signed-out' | 'signed-in' };
export type AuthError = 'unavailable' | 'invalid-input' | 'busy' | 'credentials' | 'verification' | 'mfa-required' | 'service';
export type LoginInput = { email: string; password: string };
export type LoginResult = { state: AuthState; error: AuthError | null };
export type DesktopAuthBridge = {
  getState(): Promise<AuthState>;
  signIn(input: LoginInput): Promise<LoginResult>;
  signOut(): Promise<AuthState>;
};
