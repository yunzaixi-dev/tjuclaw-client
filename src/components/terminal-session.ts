import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { AuthError } from '../lib/auth';
import { closeTerminal, describeTerminalError, openTerminal, readTerminal, resizeTerminal, sendTerminalInput, type TerminalState } from '../lib/terminal';

// One live terminal: an xterm.js view joined to a shell on a connected
// computer. Kept outside React so the render path stays free of the
// read loop, the input queue and the resize debounce.

export type TerminalStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const loadXterm = () => Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function theme(dark: boolean) {
  return {
    background: css('--terminal-background', dark ? '#141414' : '#fbfbfa'),
    foreground: css('--terminal-foreground', dark ? '#e6e6e3' : '#2b2a27'),
    cursor: dark ? '#e6e6e3' : '#2b2a27',
    cursorAccent: dark ? '#141414' : '#fbfbfa',
    selectionBackground: dark ? 'rgba(120, 160, 255, .32)' : 'rgba(35, 131, 226, .22)',
    black: dark ? '#3a3a38' : '#2b2a27', red: dark ? '#ff7b72' : '#c4362c', green: dark ? '#7ee787' : '#2f7d32',
    yellow: dark ? '#e3b341' : '#a06a00', blue: dark ? '#79c0ff' : '#1f6feb', magenta: dark ? '#d2a8ff' : '#8250df',
    cyan: dark ? '#56d4dd' : '#1b7c83', white: dark ? '#d0d0cc' : '#6e6d69',
    brightBlack: dark ? '#6e6e6a' : '#8a8984', brightRed: dark ? '#ffa198' : '#e5534b', brightGreen: dark ? '#a5f0a9' : '#3fa244',
    brightYellow: dark ? '#f2cc60' : '#c38b00', brightBlue: dark ? '#a5d6ff' : '#4493f8', brightMagenta: dark ? '#e2c5ff' : '#a475f9',
    brightCyan: dark ? '#76e3ea' : '#2aa0a8', brightWhite: dark ? '#ffffff' : '#2b2a27',
  };
}

export interface SessionOptions {
  workspaceId: string;
  cwd?: string;
  onStatus: (status: TerminalStatus, detail?: string) => void;
  /** Applies a held Ctrl to a typed key; returns the key to send. */
  transformInput?: (text: string) => string;
}

export interface TerminalSession {
  send: (text: string) => void;
  focus: () => void;
  fit: () => void;
  dispose: () => void;
}

const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

export function attachTerminal(element: HTMLElement, options: SessionOptions): TerminalSession {
  let disposed = false;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let id: string | null = null;
  let input = Promise.resolve();
  let sentSize = '';
  let resizeTimer = 0;
  const reading = new AbortController();

  const send = (text: string) => {
    if (!id || !text) return;
    const target = id;
    input = input.then(() => sendTerminalInput(target, text)).catch(() => undefined);
  };

  const fit = () => {
    if (!terminal || !fitAddon || !element.offsetWidth || !element.offsetHeight) return;
    fitAddon.fit();
    const size = `${terminal.cols}x${terminal.rows}`;
    if (!id || size === sentSize) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!id || !terminal) return;
      sentSize = size;
      void resizeTerminal(id, terminal.cols, terminal.rows).catch(() => undefined);
    }, 120);
  };

  async function readLoop(target: string) {
    let cursor = 0;
    let state: TerminalState = 'opening';
    let failures = 0;
    while (!disposed) {
      let read;
      try {
        read = await readTerminal(target, cursor, state, reading.signal);
      } catch (error) {
        if (disposed) return;
        if (error instanceof AuthError && (error.status === 404 || error.status === 401)) {
          terminal?.write('\r\n\x1b[2m[连接已结束]\x1b[0m\r\n');
          options.onStatus('closed', error.status === 404 ? '服务已重启，终端已结束' : '登录已过期');
          return;
        }
        options.onStatus('reconnecting');
        await new Promise(resolve => window.setTimeout(resolve, Math.min(8000, 600 * 2 ** failures++)));
        continue;
      }
      failures = 0;
      if (read.skipped) terminal?.write('\r\n\x1b[2m[输出过多，已跳过较早的部分]\x1b[0m\r\n');
      if (read.data.length) terminal?.write(read.data);
      cursor = read.cursor;
      state = read.state;
      if (state === 'open') options.onStatus('open');
      if (state === 'closed') {
        const detail = read.error ? describeTerminalError(read.error) : `进程已退出${read.exitCode === undefined ? '' : `，代码 ${read.exitCode}`}`;
        terminal?.write(`\r\n\x1b[2m[${detail}]\x1b[0m\r\n`);
        options.onStatus('closed', detail);
        return;
      }
    }
  }

  void (async () => {
    options.onStatus('connecting');
    const [{ Terminal }, { FitAddon }] = await loadXterm();
    if (disposed) return;
    terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: window.innerWidth <= 720 ? 12 : 13, lineHeight: 1.18, cursorBlink: true, scrollback: 5000,
      theme: theme(isDark()), allowProposedApi: false, macOptionIsMeta: true,
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    fitAddon.fit();
    terminal.onData(text => send(options.transformInput ? options.transformInput(text) : text));
    try {
      id = await openTerminal(options.workspaceId, { cols: terminal.cols, rows: terminal.rows }, options.cwd);
    } catch (error) {
      if (disposed) return;
      const detail = describeTerminalError(error instanceof AuthError ? error.body.error?.id : undefined);
      terminal.write(`\x1b[2m[${detail}]\x1b[0m\r\n`);
      options.onStatus('closed', detail);
      return;
    }
    if (disposed) { void closeTerminal(id); return; }
    sentSize = `${terminal.cols}x${terminal.rows}`;
    terminal.focus();
    void readLoop(id);
  })();

  return {
    send,
    focus: () => terminal?.focus(),
    fit,
    dispose: () => {
      disposed = true;
      reading.abort();
      window.clearTimeout(resizeTimer);
      if (id) void closeTerminal(id);
      terminal?.dispose();
    },
  };
}
