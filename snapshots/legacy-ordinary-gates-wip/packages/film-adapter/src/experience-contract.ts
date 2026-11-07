/** Native-only fixed, build-owned runtime. Never carry this object across IPC. */
export type StudioExperienceRuntime = Readonly<{
  sourcePin: '2e18a4bdf54647b2ece3c0975a6f9573720c7821';
  browser: Readonly<{ timelineMjs: string; filmDocMjs: string; overridesMjs: string; bridgeJs: string }>;
  pure: Readonly<{
    readFilm: (film: unknown) => unknown;
    applyOps: (film: unknown, ops: unknown[]) => unknown;
    filmHtml: (film: unknown, before?: string) => string;
  }>;
}>;
export type StudioExperienceRoute = 'document' | 'asset' | 'api' | 'ws' |
  'preview' | 'preview-film' | 'preview-runtime' | 'preview-asset';
export type StudioExperience = Readonly<{
  studioOrigin: string;
  previewOrigin: string;
  route(url: string, method: string): StudioExperienceRoute | undefined;
  requestHeaders(headers: Record<string, string>, allow: boolean): Record<string, string>;
  close(): Promise<void>;
}>;
