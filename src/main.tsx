import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LoadingFallback } from './components/loading-fallback';
import './lib/appearance';
import './product.css';
import './scrollbars.css';

const App = lazy(() => import.meta.env.MODE === 'audit' ? import('./audit')
  : location.pathname === '/preview/appearance' ? import('./product')
  : location.pathname.startsWith('/workspace') ? import('./workspace') : import('./auth'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<LoadingFallback />}>
      <App />
    </Suspense>
  </StrictMode>,
);
