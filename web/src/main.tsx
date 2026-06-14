import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA offline shell — register the service worker in prod builds.
// Gated on import.meta.env.PROD so dev never gets one (Vite dev server
// doesn't serve sw.js anyway, but explicit beats implicit).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Registration failure is non-fatal: the app still works, just
      // without offline shell. Log so production breakage is visible
      // in devtools without crashing the app.
      console.warn("[pwa] service worker registration failed:", err);
    });
  });
}
