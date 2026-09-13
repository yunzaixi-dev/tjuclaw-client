import wasmURL from '@cap.js/wasm/browser/cap_wasm_bg.wasm?url';
import pakoURL from 'pako/dist/pako_inflate.min.js?url';

// The widget eagerly preloads WASM during module evaluation. Configure local
// assets in an earlier dependency so its first request also stays same-origin.
declare global {
  interface Window { CAP_CUSTOM_WASM_URL?: string; CAP_PAKO_URL?: string }
}
window.CAP_CUSTOM_WASM_URL = new URL(wasmURL, window.location.href).href;
window.CAP_PAKO_URL = new URL(pakoURL, window.location.href).href;
