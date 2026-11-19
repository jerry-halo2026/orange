// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { studioHost } from '../../lib/host';
import type { SettingsSection } from './SettingsModal';

/** Both editor and launcher follow the native Settings command; each page has its own dialog. */
export function useSettings(active = true) {
  const [section, setSection] = React.useState<SettingsSection | null>(null);
  React.useEffect(() => active ? studioHost?.settings?.onOpen(() => setSection('general')) : undefined, [active]);
  React.useEffect(() => { if (!active) setSection(null); }, [active]);
  return [section, setSection] as const;
}
