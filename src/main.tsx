import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Auth from './auth';
import { ContestBanner } from './contest-banner';
import { LoadingFallback } from './components/loading-fallback';
import './lib/appearance';
import { installScrollActivity } from './lib/scroll-activity';
import './product.css';
import './scrollbars.css';

installScrollActivity();

const App = import.meta.env.MODE === 'audit' ? lazy(() => import('./audit'))
  : location.pathname === '/preview/appearance' ? lazy(() => import('./product'))
  : location.pathname.startsWith('/workspace') ? lazy(() => import('./workspace')) : Auth;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.MODE === 'audit' ? null : <ContestBanner />}
    <Suspense fallback={<LoadingFallback />}>
      <App />
    </Suspense>
  </StrictMode>,
);
