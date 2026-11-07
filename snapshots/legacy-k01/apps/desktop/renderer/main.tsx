import './startup.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop renderer root is missing');
createRoot(root).render(<App />);
