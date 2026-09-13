import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Auth from './auth';
import { LoadingFallback } from './components/loading-fallback';
import './lib/appearance';
import './product.css';
import './scrollbars.css';

const App = import.meta.env.MODE === 'audit' ? lazy(() => import('./audit'))
  : location.pathname === '/preview/appearance' ? lazy(() => import('./product'))
  : location.pathname.startsWith('/workspace') ? lazy(() => import('./workspace')) : Auth;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<LoadingFallback />}>
      <App />
    </Suspense>
  </StrictMode>,
);
