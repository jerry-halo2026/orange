import { StudioApp } from '@orange/film-adapter/renderer';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('studio-root');
if (!root) throw new Error('Studio renderer root is missing');
createRoot(root).render(<StudioApp />);
