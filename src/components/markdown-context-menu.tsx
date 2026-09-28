import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { EditorView } from '@codemirror/view';
import { Search, X } from 'lucide-react';
import { actions, applyAction, type Action } from './markdown-actions';

export function MarkdownContextMenu({ view, position, onClose }: { view: EditorView; position: { x: number; y: number }; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState(position);
  const available = actions.filter(action => action.label.toLowerCase().includes(query.trim().toLowerCase()) &&
    (!['cut', 'copy'].includes(action.text ?? '') || !view.state.selection.main.empty));

  useEffect(() => {
    if (!window.matchMedia('(max-width: 720px)').matches) searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        view.focus();
      }
    };
    const closeOnScroll = (event: Event) => { if (!panelRef.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [onClose, view]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    setOrigin({
      x: Math.max(12, Math.min(position.x, window.innerWidth - panel.offsetWidth - 12)),
      y: Math.max(12, Math.min(position.y, window.innerHeight - panel.offsetHeight - 12)),
    });
  }, [position]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setKeyboardInset(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);

  async function run(action: Action) {
    try {
      await applyAction(view, action);
      onClose();
    } catch {
      setError('剪贴板不可用，请检查浏览器权限。');
    }
  }

  return createPortal(<>
    <button type="button" className="markdown-context-backdrop" aria-label="关闭 Markdown 菜单" onClick={onClose} />
    <div ref={panelRef} className="markdown-context-menu" role="dialog" aria-label="Markdown 编辑菜单"
      style={{ left: origin.x, top: origin.y, '--keyboard-inset': `${keyboardInset}px` } as CSSProperties}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <div className="markdown-context-search"><Search size={17} aria-hidden="true" />
        <input ref={searchRef} aria-label="查找 Markdown 命令" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % Math.max(1, available.length)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + available.length) % Math.max(1, available.length)); }
            if (event.key === 'Enter' && available[active]) { event.preventDefault(); void run(available[active]); }
          }} placeholder="格式、标题、插入…" />
        {query ? <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); setActive(0); searchRef.current?.focus(); }}><X size={15} /></button> : <kbd>Esc</kbd>}
      </div>
      <div className="markdown-context-results">
        {['文本格式', '段落与标题', '插入', '编辑'].map(group => {
          const items = available.filter(action => action.group === group);
          return items.length ? <section key={group} aria-label={group}><h3>{group}</h3>
            {items.map(action => {
              const Icon = action.icon;
              return <button key={action.label} type="button" className={available.indexOf(action) === active ? 'is-active' : ''}
                onMouseEnter={() => setActive(available.indexOf(action))}
                onClick={() => void run(action)}><Icon size={17} strokeWidth={1.7} aria-hidden="true" />
                <span>{action.label}</span>{action.kind === 'heading' && Number(action.text) ? <small>H{action.text}</small> : null}</button>;
            })}
          </section> : null;
        })}
        {!available.length ? <p className="markdown-context-empty">没有匹配的命令</p> : null}
      </div>
      {error ? <p className="markdown-context-error" role="alert">{error}</p> : null}
    </div>
  </>, document.body);
}
