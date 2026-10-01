import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Brain, Check, ChevronDown, Copy, Loader2, Settings2, Sparkles } from 'lucide-react';
import { Working } from './agent-live';
import { AgentSteps } from './agent-steps';
import { LifeBackground } from './life-background';
import { agentEffort, chooseProductModel, prepareSession, setAgentEffort, type AgentEffort, exhaustedQuotaWindow, formatQuotaReset, getModel, modelDisplayName, type AgentCapabilities, type ChatSession, type ModelStatus } from '../lib/library';
import { matchingCommands, slashQuery, type PiCommand } from '../lib/pi-commands';
import { agentRuntime } from '../lib/local-sandbox';
import './agent-thread.css';


/** What the Agent can reach on this server, grouped for display. */
function capabilityLabels(tools: string[]) {
  const labels: string[] = [];
  if (tools.some(name => name.startsWith('campus_'))) labels.push('校园服务');
  if (tools.includes('search_course_materials')) labels.push('课程资料');
  if (tools.includes('read_image')) labels.push('看图');
  if (tools.some(name => name.endsWith('_entry') || name === 'list_tree')) labels.push('你的笔记');
  return labels;
}

/** Conversations whose sandbox this page already asked to warm. */
const warmed = new Set<string>();

/** TJUClaw in figlet's ANSI Shadow, for the empty conversation. */
const TITLE_ART = "████████╗  ██╗██╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗\n╚══██╔══╝  ██║██║   ██║██╔════╝██║     ██╔══██╗██║    ██║\n   ██║     ██║██║   ██║██║     ██║     ███████║██║ █╗ ██║\n   ██║██   ██║██║   ██║██║     ██║     ██╔══██║██║███╗██║\n   ██║╚█████╔╝╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝\n   ╚═╝ ╚════╝  ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ \n                                                         ";

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
    <button type="button" className="agent-chip is-button" aria-haspopup="menu" aria-expanded={open} aria-label={`思考强度：${current.label}`} onClick={() => setOpen(value => !value)}>
      <Brain size={12} aria-hidden="true" /><span>{current.value ? `${current.label}思考` : '思考'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div className="agent-model-menu" role="menu" aria-label="思考强度">
      <p className="agent-menu-title">思考强度</p>
      {EFFORTS.map(item => <MenuOption key={item.value || 'auto'} selected={item.value === effort} label={item.label} hint={item.hint}
        onSelect={() => { setEffort(item.value); setAgentEffort(item.value); setOpen(false); }} />)}
    </div> : null}
  </div>;
}

function ModelPill({ onManage }: { onManage: () => void }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // An unreadable status still offers the settings entry rather than hiding the picker.
    getModel(controller.signal).then(setStatus).catch(() => { if (!controller.signal.aborted) setStatus({ configured: false, source: 'none', name: '', quota: { limit: 0, used: 0, remaining: 0 } }); });
    return () => controller.abort();
  }, []);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, close, ref);
  // Hold the chip's place while the status loads, so the bar does not shift.
  if (!status) return <span className="agent-chip is-loading" aria-hidden="true"><Sparkles size={12} /><span>模型</span></span>;
  const missing = status.source === 'none';
  const choices = status.source === 'product' ? status.choices ?? [] : [];
  // Rolling limits apply to product models only; a custom upstream is not counted.
  const windows = status.source === 'product' ? status.windows ?? [] : [];
  const exhausted = exhaustedQuotaWindow({ windows });
  const reset = exhausted ? formatQuotaReset(exhausted.resets_at) : '';
  const label = missing ? '未配置模型' : exhausted ? `额度已用完${reset ? ` · ${reset} 恢复` : ''}` : modelDisplayName(status);
  return (
    <div className="agent-model" ref={ref}>
      <button type="button" className={`agent-chip is-button${missing || exhausted ? ' is-warning' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`模型：${label}`} disabled={busy} onClick={() => setOpen(value => !value)}>
        {busy ? <Loader2 className="animate-spin" size={12} aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}<span>{label}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? <div className="agent-model-menu" role="menu" aria-label="选择模型">
        <p className="agent-menu-title">模型</p>
        {missing ? <p>服务器还没有接入产品模型。你可以先填写自己的 OpenAI 兼容上游。</p> : null}
        {choices.map(name => {
          const selected = name === status.name;
          return <MenuOption key={name} selected={selected} label={modelDisplayName({ source: 'product', name })} hint="TJUClaw 提供" onSelect={() => {
            setOpen(false);
            if (selected) return;
            setBusy(true);
            chooseProductModel(name).then(setStatus).catch(() => undefined).finally(() => setBusy(false));
          }} />;
        })}
        {status.source === 'custom' ? <MenuOption selected label={label} hint="你自己的模型服务" onSelect={() => setOpen(false)} /> : null}
        {choices.length || status.source === 'custom' ? <hr /> : null}
        <button type="button" role="menuitem" className="agent-model-manage" onClick={() => { setOpen(false); onManage(); }}><span className="agent-menu-check" aria-hidden="true"><Settings2 size={14} /></span><span>{missing ? '配置模型…' : '模型与额度设置…'}</span></button>
      </div> : null}
    </div>
  );
}

export function AgentThread({ title, chat, capabilities, loading, error, draft, sending, pending, modelVersion, onDraftChange, onSubmit, onRetry, onManageModels, onNewChat, onShowHistory, renderMarkdown }: {
  title: string;
  chat: ChatSession | null;
  capabilities: AgentCapabilities | null;
  loading: boolean;
  error: string;
  draft: string;
  sending: boolean;
  /** The message being sent, shown at once before the server confirms it. */
  pending?: string;
  /** Changes when model settings may have changed, to re-read the model. */
  modelVersion: number;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRetry: () => void;
  onManageModels: () => void;
  /** Starts another conversation. `/new` in the composer. */
  onNewChat?: () => void;
  /** Opens the conversation list. `/resume` in the composer. */
  onShowHistory?: () => void;
  renderMarkdown: (markdown: string) => string;
}) {
  const messages = (chat?.messages ?? []).filter(message => message.content);
  const tools = capabilities?.tools ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [commandNote, setCommandNote] = useState('');
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

  // Cached history shows at once; the server copy replaces it quietly.
  const empty = Boolean(chat) && !messages.length && !sending && !pending && !(loading && !chat?.messages);
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
          <span className="agent-composer-tools">
            <ModelPill key={`${modelVersion}:${messages.length}:${error ? 1 : 0}`} onManage={onManageModels} />
            <EffortPicker />
          </span>
          <button type="submit" className="agent-send" aria-label="发送" title="发送" disabled={!chat || sending || !draft.trim()}>
            {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </form>
      <p className="agent-disclaimer">以上内容由智能体生成，仅供参考</p>
      {commandNote ? <p className="agent-command-note" role="status">{commandNote}</p> : null}
      </>
  );
  const notice = error && chat ? <div className="agent-notice" role="alert"><span>{error}</span>{error.includes('未确认') ? <button type="button" onClick={onRetry}>确认发送结果</button> : null}</div> : null;
  let body: ReactNode;
  if (loading && !chat) {
    body = <div className="agent-skeleton" role="status" aria-label="正在加载会话"><span className="is-user" /><span className="is-line" /><span className="is-short" /></div>;
  } else if (!chat) body = <div className="agent-feedback"><p>{error || '暂时无法连接会话。'}</p><button type="button" onClick={onRetry}>重试</button></div>;
  else if (!messages.length && !sending && !pending) {
    body = <div className="agent-empty">
      <h2 className="agent-ascii" aria-label={`今天想让${title}做什么？`}>
        <pre aria-hidden="true">{TITLE_ART}</pre>
        <span className="agent-ascii-prompt" aria-hidden="true"><b>&gt;</b> 今天想让 {title} 做什么？<i /></span>
      </h2>
      {composer}
      {notice}
      {capabilityLabels(tools).length ? <ul className="agent-capabilities" aria-label="可以使用">{capabilityLabels(tools).map(label => <li key={label}>{label}</li>)}</ul> : null}

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
            </header>
            <AgentSteps steps={message.steps} tools={message.tools} />
            <div className="chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
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
      {sending ? <Working name={title} sessionId={chat?.id} renderMarkdown={renderMarkdown} onProgress={followLive} /> : null}
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
