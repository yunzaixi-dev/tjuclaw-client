import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Check, Copy, FileText, Loader2, Square } from 'lucide-react';
import { Working } from './agent-live';
import { AgentSteps } from './agent-steps';
import { LifeBackground } from './life-background';
import { agentEffort, chooseProductModel, prepareSession, setAgentEffort, type AgentEffort, exhaustedQuotaWindow, formatModelRate, formatQuotaReset, getModel, modelDisplayName, quotaShareLeft, quotaWindowName, type ChatSession, type ModelStatus } from '../lib/library';
import { matchingCommands, slashQuery, type PiCommand } from '../lib/pi-commands';
import { agentRuntime } from '../lib/local-sandbox';
import { greeting } from '../lib/greeting.ts';
import { BrandIcon } from './brand-icon';
import './agent-thread.css';


/** Conversations whose sandbox this page already asked to warm. */
const warmed = new Set<string>();

/** Closes a chip menu on an outside press or Escape. */
function useMenuDismiss(open: boolean, close: () => void, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, close, ref]);
}

const EFFORTS: { value: AgentEffort; label: string; hint: string }[] = [
  { value: '', label: '自动', hint: '由模型决定思考多久' },
  { value: 'low', label: '快速', hint: '少想一点，更快回答' },
  { value: 'high', label: '深入', hint: '多想一会儿，推理更仔细' },
];

/** One option in a composer menu: check on the left, name and a hint. */
function MenuOption({ selected, label, hint, onSelect }: { selected: boolean; label: string; hint?: string; onSelect: () => void }) {
  return <button type="button" role="menuitemradio" aria-checked={selected} className="agent-menu-option" onClick={onSelect}>
    <span className="agent-menu-check" aria-hidden="true">{selected ? <Check size={14} /> : null}</span>
    <span className="agent-menu-text"><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>
  </button>;
}

/** Thinking strength for the next turns, remembered on this device. */
function EffortPicker() {
  const [effort, setEffort] = useState<AgentEffort>(() => agentEffort());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, close, ref);
  useEffect(() => {
    const sync = () => setEffort(agentEffort());
    window.addEventListener('tjuclaw:agent-effort', sync);
    return () => window.removeEventListener('tjuclaw:agent-effort', sync);
  }, []);
  const current = EFFORTS.find(item => item.value === effort) ?? EFFORTS[0];
  return <div className="agent-model" ref={ref}>
    <button type="button" className="agent-pill-part is-quiet" aria-haspopup="menu" aria-expanded={open} aria-label={`思考强度：${current.label}`} onClick={() => setOpen(value => !value)}>{current.label}</button>
    {open ? <div className="agent-model-menu" role="menu" aria-label="思考强度">
      <p className="agent-menu-title">思考强度</p>
      {EFFORTS.map(item => <MenuOption key={item.value || 'auto'} selected={item.value === effort} label={item.label} hint={item.hint}
        onSelect={() => { setEffort(item.value); setAgentEffort(item.value); setOpen(false); }} />)}
    </div> : null}
  </div>;
}

/** Reads the model status again whenever `version` changes. null while loading. */
function useModelStatus(version: string): [ModelStatus | null, (status: ModelStatus) => void] {
  const [loaded, setLoaded] = useState<{ version: string; status: ModelStatus } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // An unreadable status still offers the settings entry rather than hiding the picker.
    getModel(controller.signal).then(status => setLoaded({ version, status }))
      .catch(() => { if (!controller.signal.aborted) setLoaded({ version, status: { configured: false, source: 'none', name: '', quota: { limit: 0, used: 0, remaining: 0 } } }); });
    return () => controller.abort();
  }, [version]);
  // Keep showing the last status while a newer one loads, so the row does not blink.
  return [loaded?.status ?? null, status => setLoaded({ version, status })];
}

/** The model as plain text; its menu switches between the product models. */
function ModelPicker({ status, onStatus, onManage }: { status: ModelStatus | null; onStatus: (status: ModelStatus) => void; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, close, ref);
  // Hold the text's place while the status loads, so the row does not shift.
  if (!status) return <span className="agent-pill-part is-loading" aria-hidden="true">模型</span>;
  const missing = status.source === 'none';
  const choices = status.source === 'product' ? status.choices ?? [] : [];
  const label = missing ? '未配置模型' : modelDisplayName(status);
  return (
    <div className="agent-model" ref={ref}>
      <button type="button" className="agent-pill-part" aria-haspopup="menu" aria-expanded={open} aria-label={`模型：${label}`} disabled={busy} onClick={() => setOpen(value => !value)}>{busy ? '切换中…' : label}</button>
      {open ? <div className="agent-model-menu" role="menu" aria-label="选择模型">
        <p className="agent-menu-title">模型</p>
        {missing ? <p>服务器还没有接入产品模型。你可以先填写自己的 OpenAI 兼容上游。</p> : null}
        {choices.map(name => {
          const selected = name === status.name;
          const rate = formatModelRate(status.rates?.[name]);
          return <MenuOption key={name} selected={selected} label={modelDisplayName({ source: 'product', name })} hint={rate ? `TJUClaw 提供 · ${rate}` : 'TJUClaw 提供'} onSelect={() => {
            setOpen(false);
            if (selected) return;
            setBusy(true);
            chooseProductModel(name).then(onStatus).catch(() => undefined).finally(() => setBusy(false));
          }} />;
        })}
        {status.source === 'custom' ? <MenuOption selected label={label} hint="你自己的模型服务" onSelect={() => setOpen(false)} /> : null}
        {choices.length || status.source === 'custom' ? <hr /> : null}
        <button type="button" role="menuitem" className="agent-model-manage" onClick={() => { setOpen(false); onManage(); }}><span className="agent-menu-check" aria-hidden="true" /><span>{missing ? '配置模型…' : '模型与额度设置…'}</span></button>
      </div> : null}
    </div>
  );
}

/** One line under the composer saying how much of the allowance is left. */
function allowanceText(status: ModelStatus | null): { text: string; warning: boolean } {
  if (!status) return { text: '', warning: false };
  if (status.source === 'custom') return { text: '使用自己的模型，不占用额度', warning: false };
  if (status.source === 'none') return { text: '还没有可用的模型', warning: true };
  const windows = status.windows ?? [];
  const exhausted = exhaustedQuotaWindow({ windows });
  if (exhausted) {
    const reset = formatQuotaReset(exhausted.resets_at);
    return { text: `${quotaWindowName(exhausted.id)}额度已用完${reset ? `，${reset} 恢复` : ''}`, warning: true };
  }
  // The tightest window is the one that will stop the next turn first.
  const tightest = [...windows].sort((x, y) => quotaShareLeft(x) - quotaShareLeft(y))[0];
  return tightest ? { text: `${quotaWindowName(tightest.id)}额度剩余 ${quotaShareLeft(tightest)}%`, warning: quotaShareLeft(tightest) <= 10 } : { text: '', warning: false };
}

export function AgentThread({ title, chat, loading, error, draft, sending, stopping, pending, modelVersion, onDraftChange, onSubmit, onStop, onRetry, onManageModels, onNewChat, onShowHistory, onOpenNote, renderMarkdown }: {
  title: string;
  chat: ChatSession | null;
  loading: boolean;
  error: string;
  draft: string;
  sending: boolean;
  /** A stop was requested and the turn is winding down. */
  stopping?: boolean;
  /** The message being sent, shown at once before the server confirms it. */
  pending?: string;
  /** Changes when model settings may have changed, to re-read the model. */
  modelVersion: number;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  /** Stops the running turn. Absent where a turn cannot be stopped. */
  onStop?: () => void;
  onRetry: () => void;
  onManageModels: () => void;
  /** Starts another conversation. `/new` in the composer. */
  onNewChat?: () => void;
  /** Opens the conversation list. `/resume` in the composer. */
  onShowHistory?: () => void;
  /** Opens a note the Agent created or changed. */
  onOpenNote?: (entryId: string) => void;
  renderMarkdown: (markdown: string) => string;
}) {
  const messages = (chat?.messages ?? []).filter(message => message.content);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [commandNote, setCommandNote] = useState('');
  // Chosen once per visit, so the words do not change while the page is open.
  const [hello] = useState(() => greeting(new Date().getHours()));
  // Read again after each turn and after the settings close: the allowance moved.
  const [modelStatus, setModelStatus] = useModelStatus(`${modelVersion}:${messages.length}:${error ? 1 : 0}`);
  const allowance = allowanceText(modelStatus);
  const slash = slashQuery(draft);
  // Index belongs to one slash query. A new query shows the first match without an effect.
  const [commandCursor, setCommandCursor] = useState<{ slash: string | null; index: number }>({ slash: null, index: 0 });
  const commandIndex = commandCursor.slash === slash ? commandCursor.index : 0;
  const setCommandIndex = (value: number | ((index: number) => number)) => {
    setCommandCursor(current => {
      const index = current.slash === slash ? current.index : 0;
      return { slash, index: typeof value === 'function' ? value(index) : value };
    });
  };
  const commands = slash ? matchingCommands(slash) : [];
  const commandOpen = Boolean(slash) && !sending;

  useEffect(() => {
    const area = scrollRef.current;
    if (area) area.scrollTo({ top: area.scrollHeight, behavior: messages.length ? 'smooth' : 'auto' });
  }, [chat?.id, messages.length, sending]);

  // Keep the growing live output in view, unless the reader scrolled up.
  const followLive = useCallback(() => {
    const area = scrollRef.current;
    if (area && area.scrollHeight - area.scrollTop - area.clientHeight < 200) area.scrollTop = area.scrollHeight;
  }, []);

  // Starting to write is the signal a message is coming: warm the cloud
  // sandbox now, once per conversation, so the first reply does not wait for it.
  const chatId = chat?.id;
  const writing = Boolean(draft.trim());
  useEffect(() => {
    if (!chatId || !writing || warmed.has(chatId) || agentRuntime() !== 'cloud') return;
    warmed.add(chatId);
    void prepareSession(chatId);
  }, [chatId, writing]);

  const runCommand = (command: PiCommand) => {
    if (!command.available || !command.action) {
      setCommandNote(`${command.label}需要在 Pi 终端里使用，这里不会把它发给模型。`);
      return;
    }
    if (command.action === 'new') { onDraftChange(''); setCommandNote(''); onNewChat?.(); return; }
    if (command.action === 'model') { onDraftChange(''); setCommandNote(''); onManageModels(); return; }
    if (command.action === 'resume') { onDraftChange(''); setCommandNote(''); onShowHistory?.(); return; }
    if (command.action === 'thinking') {
      const order: AgentEffort[] = ['', 'low', 'high'];
      const next = order[(order.indexOf(agentEffort()) + 1) % order.length];
      setAgentEffort(next);
      window.dispatchEvent(new CustomEvent('tjuclaw:agent-effort'));
      const label = EFFORTS.find(item => item.value === next)?.label ?? '自动';
      onDraftChange('');
      setCommandNote(`思考强度：${label}`);
      return;
    }
    if (command.action === 'copy') {
      const last = [...messages].reverse().find(message => message.role === 'assistant' && message.content);
      if (!last) { setCommandNote('还没有可复制的回复。'); return; }
      void navigator.clipboard?.writeText(last.content);
      onDraftChange('');
      setCommandNote('已复制上一条回复。');
      return;
    }
    const updated = chat?.updated_at ? new Date(chat.updated_at).toLocaleString('zh-CN', { hour12: false }) : '';
    onDraftChange('');
    setCommandNote(chat ? `会话 ${chat.id.slice(0, 8)} · ${messages.length} 条消息${updated ? ` · ${updated}` : ''}` : '会话尚未就绪。');
  };

  const submitComposer = (event: FormEvent) => {
    if (slash) {
      event.preventDefault();
      const exact = commands.find(command => command.name === slash);
      const chosen = exact ?? (commands.length === 1 ? commands[0] : commands[commandIndex]);
      if (chosen) runCommand(chosen);
      else setCommandNote('这里没有这条指令。输入 / 查看可以在这里用的指令。');
      return;
    }
    onSubmit(event);
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (commandOpen && commands.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCommandIndex(index => {
          const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
          return (next + commands.length) % commands.length;
        });
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const chosen = commands[commandIndex] ?? commands[0];
        if (chosen) onDraftChange(chosen.name);
        return;
      }
    }
    if (event.key === 'Escape' && commandOpen) { event.preventDefault(); onDraftChange(''); setCommandNote(''); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  // Grow the composer with its content, up to a comfortable height.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [draft]);

  // A conversation with nothing in it greets the user with the composer in the
  // middle. A conversation nobody wrote in comes back without a messages field,
  // loaded or not, so the field cannot tell "still loading" from "empty": what
  // is on screen now decides, and the server copy replaces it quietly.
  const empty = Boolean(chat) && !messages.length && !sending && !pending;
  const composer = (
      <>
      <form className="agent-composer" onSubmit={submitComposer}>
        {commandOpen ? <div id="agent-command-menu" className="agent-command-menu" role="listbox" aria-label="Pi 指令">
          <p>指令</p>
          {commands.length ? commands.map((command, index) => <button type="button" key={command.name} role="option" aria-selected={index === commandIndex} className={`agent-command-option${index === commandIndex ? ' is-active' : ''}`} onMouseEnter={() => setCommandIndex(index)} onClick={() => runCommand(command)}>
            <code>{command.name}</code><strong>{command.label}</strong><small>{command.hint}</small>
          </button>) : <p>没有匹配的指令</p>}
        </div> : null}
        <label htmlFor="session-draft" className="sr-only">发送给 Agent 的消息</label>
        <textarea ref={inputRef} id="session-draft" value={draft} rows={1}
          onChange={event => { setCommandNote(''); onDraftChange(event.target.value); }}
          placeholder={chat ? '提问、搜索或创建任何内容，输入 / 查看指令' : '会话尚未就绪'}
          disabled={!chat || sending}
          aria-expanded={commandOpen}
          aria-controls={commandOpen ? 'agent-command-menu' : undefined}
          onKeyDown={onComposerKeyDown} />
        <div className="agent-composer-bar">
          {sending && onStop
            ? <button type="button" className="agent-send is-stop" aria-label={stopping ? '正在停止' : '停止'} title={stopping ? '正在停止' : '停止'} disabled={stopping} onClick={onStop}>
              <Square size={12} fill="currentColor" strokeWidth={0} />
            </button>
            : <button type="submit" className="agent-send" aria-label="发送" title="发送" disabled={!chat || sending || !draft.trim()}>
              {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.4} />}
            </button>}
        </div>
      </form>
      {/* Like a letterhead under the box: what is left on the left, the model on the right. */}
      <div className="agent-composer-meta">
        {allowance.text ? <button type="button" className={`agent-meta-link${allowance.warning ? ' is-warning' : ''}`} onClick={onManageModels}>{allowance.text}</button> : <span />}
        <div className="agent-pill" role="group" aria-label="模型与思考强度">
          <ModelPicker status={modelStatus} onStatus={setModelStatus} onManage={onManageModels} />
          <EffortPicker />
        </div>
      </div>
      <p className="agent-disclaimer">以上内容由智能体生成，仅供参考</p>
      {commandNote ? <p className="agent-command-note" role="status">{commandNote}</p> : null}
      </>
  );
  const notice = error && chat ? <div className="agent-notice" role="alert"><span>{error}</span>{error.includes('未确认') ? <button type="button" onClick={onRetry}>确认发送结果</button> : null}</div> : null;
  let body: ReactNode;
  if (loading && !chat) {
    body = <div className="agent-skeleton" role="status" aria-label="正在加载会话"><span className="is-user" /><span className="is-line" /><span className="is-short" /></div>;
  } else if (!chat) body = <div className="agent-feedback"><p>{error || '暂时无法连接会话。'}</p><button type="button" onClick={onRetry}>重试</button></div>;
  else if (empty) {
    // The same condition places the composer here instead of the dock, so there is always exactly one.
    body = <div className="agent-empty">
      <h2 className="agent-greeting"><BrandIcon size={44} /><span>{hello}</span></h2>
      {composer}
      {notice}

    </div>;
  } else {
    body = <div className="session-transcript">
      {messages.map((message, index) => message.role === 'user'
        ? <article key={`${message.created_at}-${index}`} className="chat-message user"><p>{message.content}</p></article>
        : <article key={`${message.created_at}-${index}`} className="chat-message assistant">
          <div className="agent-reply-body">
            <header className="agent-reply-head">
              <span className="agent-reply-name">{title}</span>
              <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
              {message.interrupted ? <span className="agent-reply-stopped">已停止</span> : null}
            </header>
            <AgentSteps steps={message.steps} tools={message.tools} />
            <div className="chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
            {message.notes?.length && onOpenNote ? <ul className="agent-reply-notes" aria-label="本次写入的笔记">
              {message.notes.map(note => <li key={note.entry_id}>
                <button type="button" onClick={() => onOpenNote(note.entry_id)} title={`打开笔记「${note.title}」`}>
                  <FileText size={14} aria-hidden="true" /><span className="agent-reply-note-title">{note.title}</span><span className="agent-reply-note-change">{note.change === 'created' ? '新建' : '已更新'}</span>
                </button>
              </li>)}
            </ul> : null}
            <div className="agent-reply-actions">
              <button type="button" aria-label="复制回复" title="复制回复" onClick={() => { void navigator.clipboard?.writeText(message.content); setCopiedIndex(index); window.setTimeout(() => setCopiedIndex(current => current === index ? null : current), 1200); }}>
                {copiedIndex === index ? <Check size={13} /> : <Copy size={13} />}<span>{copiedIndex === index ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        </article>)}
      {/* The draft stays in the composer until the reply is confirmed, so a
          failed send never loses it; the transcript shows the work under way. */}
      {pending ? <article className="chat-message user is-pending" aria-label="正在发送"><p>{pending}</p></article> : null}
      {sending ? <Working name={title} sessionId={chat?.id} stopping={stopping} renderMarkdown={renderMarkdown} onProgress={followLive} /> : null}
    </div>;
  }

  return <section className={`agent-view agent-thread${empty ? ' is-empty' : ''}`} aria-label={`${title} 会话`}>
    <LifeBackground />
    <div className="agent-scroll" ref={scrollRef} role="log" aria-label="会话记录">
      {body}
    </div>
    <div className="agent-dock">
      {empty ? null : composer}
      {empty ? null : notice}
    </div>
  </section>;
}
