import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { db } from './db/db';
import { seedIfEmpty } from './db/seed';
import './styles.css';

registerSW({ immediate: true });
// Ask the browser to keep our data even under storage pressure.
navigator.storage?.persist?.().catch(() => {});
void seedIfEmpty(db);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
