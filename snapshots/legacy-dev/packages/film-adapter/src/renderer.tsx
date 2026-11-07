import type { ComponentType } from 'react';
import '@orange-studio-upstream/globals.css';

// Build-only, exact eager import of the named App export; no mock or ordinary renderer fallback.
const app = import.meta.glob<ComponentType>('/source/packages/openfilm/studio/ui/src/App.tsx', {
  eager: true, import: 'App', exhaustive: true,
})['/source/packages/openfilm/studio/ui/src/App.tsx'];

if (typeof app !== 'function') throw new Error('Pinned Studio App is missing');
export const StudioApp = app;
