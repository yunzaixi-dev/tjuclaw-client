// The running build, injected by vite.config.ts.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const appVersion: string = __APP_VERSION__;
export const appCommit: string = __APP_COMMIT__;
/** For display: v0.0.47 · 1a2b3c4 (the commit tells apart deployments of one version). */
export const versionLabel = `v${appVersion}${appCommit ? ` · ${appCommit}` : ''}`;
