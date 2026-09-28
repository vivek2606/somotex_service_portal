import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { supabase } from './cloud/supabase';
import { db, runtime } from './db/db';
import { seedIfEmpty } from './db/seed';
import './styles.css';

// Pick up new versions promptly: at start-up, hourly, and whenever the app
// comes back into view. A new version reloads the page automatically.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => void registration.update().catch(() => {});
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});
// Ask the browser to keep our data even under storage pressure.
navigator.storage?.persist?.().catch(() => {});
runtime.cloud = !!supabase;
// In shared mode the catalogue comes from the server (seeded once by the Service Head).
if (!runtime.cloud) void seedIfEmpty(db);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
