import { WorkspaceLoading } from './workspace-loading';

/**
 * Shown while a page's code downloads. The workspace shows the same screen
 * for its data steps afterwards, so the two stages read as one continuous
 * opening screen rather than two different pages.
 */
export function LoadingFallback() {
  const workspace = location.pathname.startsWith('/workspace');
  return <WorkspaceLoading step="app" title={workspace ? '正在打开你的知识花园' : '正在打开 TJUClaw'} />;
}
