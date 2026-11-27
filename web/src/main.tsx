import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateBanner } from './components/UpdateBanner';
import { SHARE_ENABLED } from './env';
import { dropShareFragment, isSharePath } from './share';
import './style.css';

// Page publique d'un QCM partage (/p#t=...): rendue SANS charger App ni auth.ts (aucun appel Cognito, aucun /me). Fermee par defaut.
async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (SHARE_ENABLED && isSharePath()) {
    const { SharePublic } = await import('./screens/SharePublic');
    root.render(<StrictMode><SharePublic /></StrictMode>);
    return;
  }
  dropShareFragment();
  const { App } = await import('./App');
  root.render(
    <StrictMode>
      <UpdateBanner />
      <App />
    </StrictMode>,
  );
}
void start();
