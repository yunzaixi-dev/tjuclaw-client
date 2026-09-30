import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion } from 'motion/react';
import { ContestBanner } from './contest-banner';
import { LoadingFallback } from './components/loading-fallback';
import { UpdateNotice } from './components/update-notice';
import './lib/appearance';
import { installScrollActivity } from './lib/scroll-activity';
import './product.css';
import './scrollbars.css';

installScrollActivity();

// Start the page's code download now, alongside this entry's own work,
// instead of when React first renders the lazy component.
const page = import.meta.env.MODE === 'audit' ? import('./audit')
  : location.pathname === '/preview/appearance' ? import('./product')
  : location.pathname.startsWith('/workspace') ? import('./workspace') : import('./auth');
const App = lazy(() => page);
// Motion's animation code (~100 KB) arrives after the first paint; the m.*
// components render statically until then.
const motionFeatures = () => import('./lib/motion-features').then(module => module.default);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.MODE === 'audit' ? null : <ContestBanner />}
    <LazyMotion features={motionFeatures} strict>
      <Suspense fallback={<LoadingFallback />}>
        <App />
      </Suspense>
    </LazyMotion>
    {import.meta.env.MODE === 'audit' ? null : <UpdateNotice />}
  </StrictMode>,
);
