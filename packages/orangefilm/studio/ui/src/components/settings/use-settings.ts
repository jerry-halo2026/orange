// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { studioHost } from '../../lib/host';
import type { SettingsSection } from './SettingsModal';

/**
 * 一个共享的设置对话框状态：素材面板里点「打开设置」、画布/其它页面调起设置，打开的必须是同一个对话框。
 * （以前是每个组件各自的 `useState`，MediaPool 调的是自己那份，ProjectView 的 SettingsModal 永远看不到。）
 */
let current: SettingsSection | null = null;
const listeners = new Set<() => void>();

function setSection(next: SettingsSection | null): void {
  if (next === current) return;
  current = next;
  for (const notify of listeners) notify();
}

/** Both editor and launcher follow the native Settings command; each page has its own dialog. */
export function useSettings(active = true) {
  const section = React.useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => current,
    () => current,
  );
  React.useEffect(() => (active ? studioHost?.settings?.onOpen(() => setSection('general')) : undefined), [active]);
  return [section, setSection] as const;
}
