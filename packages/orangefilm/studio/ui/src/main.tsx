// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OrangeApp } from './OrangeApp';
import { FocusNav } from './components/FocusNav';
import './globals.css';
import { applyStudioHost } from './lib/host';

applyStudioHost();

createRoot(document.getElementById('root')!).render(<StrictMode><FocusNav /><OrangeApp /></StrictMode>);
