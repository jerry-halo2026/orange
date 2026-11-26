// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Settings and the real model picker share a native bridge fixture; no inference is sent. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsSection } from '../../../packages/orangefilm/studio/ui/src/components/settings/AgentsSection';
import { ModelPopover } from '../chat/src/components/ModelPopover';
import { setLanguage } from '../chat/src/i18n';
import '../shell/shell.css';
import '../chat/src/chat.css';

setLanguage(localStorage.getItem('orangefilm.language') ?? 'en');
createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 24, maxWidth: 900 }}>
    <AgentsSection />
    <div className="of-chat mt-6" data-model-picker><ModelPopover agent="orangefilm" /></div>
    <div id="of-chat-layer" className="of-chat" />
  </div>,
);
