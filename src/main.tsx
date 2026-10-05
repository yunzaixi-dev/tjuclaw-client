import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion } from 'motion/react';
import { LoadingFallback } from './components/loading-fallback';
import { UpdateNotice } from './components/update-notice';
import { WebUpdateNotice } from './components/web-update-notice';
import './lib/appearance';
import { registerServiceWorker } from './lib/pwa';
import { installScrollActivity } from './lib/scroll-activity';
import './product.css';
import './scrollbars.css';

installScrollActivity();
registerServiceWorker();

// Start the page's code download now, alongside this entry's own work,
// instead of when React first renders the lazy component.
const page = import.meta.env.MODE === 'audit' ? import('./audit')
  : location.pathname === '/preview/appearance' ? import('./product')
  : location.pathname === '/workspace/connections' ? import('./workspace-connections')
  : location.pathname === '/device' ? import('./device')
  : location.pathname.startsWith('/workspace') ? import('./workspace') : import('./auth');
const App = lazy(() => page);
// Motion's animation code (~100 KB) arrives after the first paint; the m.*
// components render statically until then.
const motionFeatures = () => import('./lib/motion-features').then(module => module.default);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LazyMotion features={motionFeatures} strict>
      <Suspense fallback={<LoadingFallback />}>
        <App />
      </Suspense>
    </LazyMotion>
    {import.meta.env.MODE === 'audit' ? null : <UpdateNotice />}
    {import.meta.env.MODE === 'audit' ? null : <WebUpdateNotice />}
  </StrictMode>,
);
