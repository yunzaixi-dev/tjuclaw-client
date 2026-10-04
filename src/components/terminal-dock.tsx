import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronUp, Plus, SquareTerminal, X } from 'lucide-react';
import { attachTerminal, type TerminalSession, type TerminalStatus } from './terminal-session';
import { storedJSON, storeItem } from '../lib/safe-storage';
import './terminal-dock.css';

export interface TerminalTab { key: string; workspaceId: string; hostName: string; label: string; cwd?: string }

const HEIGHT_KEY = 'tjuclaw.terminal.height.v1';
const statusLabel: Record<TerminalStatus, string> = { connecting: '正在连接', open: '已连接', reconnecting: '正在重连', closed: '已结束' };

// Keys a phone keyboard lacks, sent as the terminal would send them.
const PHONE_KEYS: [string, string][] = [['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-']];

function RemoteTerminal({ tab, active, ctrl, onCtrlUsed, onStatus, register }: {
  tab: TerminalTab; active: boolean; ctrl: boolean; onCtrlUsed: () => void;
  onStatus: (key: string, status: TerminalStatus, detail?: string) => void;
  register: (key: string, session: TerminalSession | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef(ctrl);
  const usedRef = useRef(onCtrlUsed);
  useEffect(() => { ctrlRef.current = ctrl; usedRef.current = onCtrlUsed; }, [ctrl, onCtrlUsed]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const session = attachTerminal(element, {
      workspaceId: tab.workspaceId, cwd: tab.cwd,
      onStatus: (status, detail) => onStatus(tab.key, status, detail),
      transformInput: text => {
        if (!ctrlRef.current || text.length !== 1) return text;
        usedRef.current();
        const code = text.toUpperCase().charCodeAt(0);
        return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : text;
      },
    });
    register(tab.key, session);
    const observer = new ResizeObserver(() => session.fit());
    observer.observe(element);
    return () => { observer.disconnect(); register(tab.key, null); session.dispose(); };
    // The session lives as long as the tab; its identity never changes.
  }, [tab.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="terminal-surface" hidden={!active} aria-label={`${tab.label} 的终端`} />;
}

/**
 * Terminals on connected computers, docked under the page. Tabs stay alive
 * while hidden; closing a tab ends its shell. On a phone the dock takes the
 * screen and adds the keys a phone keyboard lacks.
 */
export default function TerminalDock({ tabs, activeKey, onActivate, onClose, onNew }: {
  tabs: TerminalTab[];
  activeKey: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onNew?: (tab: TerminalTab) => void;
}) {
  const [height, setHeight] = useState(() => storedJSON(HEIGHT_KEY, 300));
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<Record<string, { status: TerminalStatus; detail?: string }>>({});
  const [ctrl, setCtrl] = useState(false);
  const sessions = useRef(new Map<string, TerminalSession>());
  const dockRef = useRef<HTMLElement>(null);

  const register = (key: string, session: TerminalSession | null) => {
    if (session) sessions.current.set(key, session); else sessions.current.delete(key);
  };
  const reportStatus = (key: string, next: TerminalStatus, detail?: string) => setStatus(current =>
    current[key]?.status === next && current[key]?.detail === detail ? current : { ...current, [key]: { status: next, detail } });

  useEffect(() => {
    if (collapsed) return;
    const session = sessions.current.get(activeKey);
    const frame = requestAnimationFrame(() => { session?.fit(); session?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [activeKey, collapsed, height]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const dock = dockRef.current;
    const main = dock?.parentElement;
    if (!dock || !main) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dock.offsetHeight;
    const limit = main.clientHeight - 120;
    let next = startHeight;
    const move = (moveEvent: PointerEvent) => {
      next = Math.round(Math.min(limit, Math.max(140, startHeight + startY - moveEvent.clientY)));
      dock.style.height = `${next}px`;
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      setHeight(next);
      storeItem(localStorage, HEIGHT_KEY, JSON.stringify(next));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  const active = tabs.find(tab => tab.key === activeKey) ?? tabs[0];
  const activeStatus = active ? status[active.key] : undefined;

  return <section ref={dockRef} className={`terminal-dock${collapsed ? ' is-collapsed' : ''}`} style={collapsed ? undefined : { height }} aria-label="终端">
    <div className="terminal-dock-grip" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="调整终端高度" />
    <div className="terminal-dock-bar">
      <div className="terminal-tabs" role="tablist" aria-label="终端标签">
        {tabs.map(tab => {
          const state = status[tab.key]?.status ?? 'connecting';
          return <div key={tab.key} className={`terminal-tab${tab.key === active?.key ? ' is-active' : ''}`}>
            <button type="button" role="tab" aria-selected={tab.key === active?.key} title={`${tab.hostName}${tab.cwd ? ` · ${tab.cwd}` : ''}`}
              onClick={() => { onActivate(tab.key); setCollapsed(false); }}>
              <span className={`terminal-dot is-${state}`} aria-label={statusLabel[state]} />
              <span className="terminal-tab-label">{tab.label}</span>
              {tab.label !== tab.hostName ? <small>{tab.hostName}</small> : null}
            </button>
            <button type="button" className="terminal-tab-close" aria-label={`关闭终端 ${tab.label}`} onClick={() => onClose(tab.key)}><X size={13} /></button>
          </div>;
        })}
      </div>
      <div className="terminal-dock-actions">
        {onNew && active ? <button type="button" aria-label="在同一位置再开一个终端" title="新终端" onClick={() => onNew({ ...active, key: crypto.randomUUID() })}><Plus size={15} /></button> : null}
        <button type="button" aria-label={collapsed ? '展开终端' : '收起终端'} title={collapsed ? '展开' : '收起'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
        <button type="button" aria-label="关闭全部终端" title="关闭全部" onClick={() => tabs.forEach(tab => onClose(tab.key))}><X size={15} /></button>
      </div>
    </div>
    {activeStatus?.status === 'reconnecting' || (activeStatus?.status === 'closed' && activeStatus.detail) ? <p className="terminal-notice" role="status">
      <SquareTerminal size={13} aria-hidden="true" />{activeStatus.status === 'reconnecting' ? '网络中断，正在重新连接…' : activeStatus.detail}
    </p> : null}
    <div className="terminal-body">
      {tabs.map(tab => <RemoteTerminal key={tab.key} tab={tab} active={tab.key === active?.key && !collapsed} ctrl={ctrl} onCtrlUsed={() => setCtrl(false)} onStatus={reportStatus} register={register} />)}
    </div>
    <div className="terminal-phone-keys" aria-label="特殊按键">
      <button type="button" aria-pressed={ctrl} className={ctrl ? 'is-held' : ''} onClick={() => { setCtrl(value => !value); sessions.current.get(active?.key ?? '')?.focus(); }}>Ctrl</button>
      {PHONE_KEYS.map(([label, sequence]) => <button key={label} type="button" aria-label={label === '↑' ? '上' : label === '↓' ? '下' : label === '←' ? '左' : label === '→' ? '右' : label}
        onPointerDown={event => event.preventDefault()} onClick={() => { const session = sessions.current.get(active?.key ?? ''); session?.send(sequence); session?.focus(); }}>{label}</button>)}
    </div>
  </section>;
}
