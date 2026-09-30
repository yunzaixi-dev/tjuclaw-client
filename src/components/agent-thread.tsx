import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, BookOpen, Check, ChevronDown, Copy, Loader2, Settings2, Sparkles } from 'lucide-react';
import { AgentSteps } from './agent-steps';
import { chooseProductModel, exhaustedQuotaWindow, formatQuotaReset, getModel, modelDisplayName, quotaWindowName, type AgentCapabilities, type ChatSession, type ModelStatus } from '../lib/library';
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

function agentStarters(tools: string[]) {
  const campus = tools.some(name => name.startsWith('campus_'));
  const materials = tools.includes('search_course_materials');
  if (campus && materials) return ['看看我明天下午什么时候有空', '找数据结构的复习资料并整理要点', '根据我的课表安排这周复习，并保存成笔记'];
  if (campus) return ['看看我明天下午什么时候有空', '这学期还有哪些考试？', '根据我的课表安排这周复习，并保存成笔记'];
  if (materials) return ['找数据结构的复习资料并整理要点', '解释一个我还没弄懂的概念', '把这篇内容改成复习提纲'];
  return ['帮我整理这篇笔记的重点', '解释一个我还没弄懂的概念', '把这篇内容改成复习提纲'];
}

/** The Agent at work, with elapsed seconds so a long task never looks stuck. */
function Working({ name }: { name: string }) {
  // Mounted when sending starts, so the first render marks the start.
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  // Honest wording: the Agent may think, call tools and write in this time.
  const phase = seconds < 6 ? '正在理解你的问题' : '正在处理，可能会查询资料、读写笔记';
  return <div className="agent-working" role="status" aria-label={`${name}正在处理，已用 ${seconds} 秒`}>
    <div><span className="agent-working-name">{name}</span><span className="agent-working-text">{phase}</span><span className="agent-working-time">{seconds} 秒</span></div>
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
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
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
        {missing ? <p>服务器还没有接入产品模型。你可以先填写自己的 OpenAI 兼容上游。</p> : null}
        {choices.map(name => {
          const selected = name === status.name;
          return <button key={name} type="button" role="menuitemradio" aria-checked={selected} onClick={() => {
            setOpen(false);
            if (selected) return;
            setBusy(true);
            chooseProductModel(name).then(setStatus).catch(() => undefined).finally(() => setBusy(false));
          }}><span>{modelDisplayName({ source: 'product', name })}</span>{selected ? <Check size={14} aria-hidden="true" /> : null}</button>;
        })}
        {status.source === 'custom' ? <button type="button" role="menuitemradio" aria-checked="true" onClick={() => setOpen(false)}><span>{label}</span><Check size={14} aria-hidden="true" /></button> : null}
        {windows.length && choices.length ? <hr /> : null}
        {windows.length ? <div className="agent-model-usage" aria-label="AI 额度">
          {windows.map(window => <div key={window.id} className={window.remaining <= 0 ? 'is-empty' : ''}>
            <span>{quotaWindowName(window.id)}内</span>
            <meter min={0} max={window.limit} value={Math.min(window.used, window.limit)} aria-label={`${quotaWindowName(window.id)}内已用 ${window.used} / ${window.limit}`} />
            <small>{window.used} / {window.limit}{window.used && window.resets_at ? ` · ${formatQuotaReset(window.resets_at)} 起恢复` : ''}</small>
          </div>)}
        </div> : null}
        {choices.length || windows.length || status.source === 'custom' ? <hr /> : null}
        <button type="button" role="menuitem" className="agent-model-manage" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={14} aria-hidden="true" /><span>{missing ? '配置模型…' : '管理模型…'}</span></button>
      </div> : null}
    </div>
  );
}

export function AgentThread({ title, chat, capabilities, loading, error, draft, sending, pending, modelVersion, onDraftChange, onSubmit, onRetry, onManageModels, renderMarkdown }: {
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
  renderMarkdown: (markdown: string) => string;
}) {
  const messages = (chat?.messages ?? []).filter(message => message.content);
  const tools = capabilities?.tools ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    const area = scrollRef.current;
    if (area) area.scrollTo({ top: area.scrollHeight, behavior: messages.length ? 'smooth' : 'auto' });
  }, [chat?.id, messages.length, sending]);

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
      <form className="agent-composer" onSubmit={onSubmit}>
        <label htmlFor="session-draft" className="sr-only">发送给 Agent 的消息</label>
        <textarea ref={inputRef} id="session-draft" value={draft} rows={1}
          onChange={event => onDraftChange(event.target.value)}
          placeholder={chat ? '提问、搜索或创建任何内容…' : '会话尚未就绪'}
          disabled={!chat || sending}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="agent-composer-bar">
          <span className="agent-composer-tools">
            <ModelPill key={`${modelVersion}:${messages.length}:${error ? 1 : 0}`} onManage={onManageModels} />
            <span className="agent-chip" title="Agent 可以读取和修改当前知识库"><BookOpen size={12} aria-hidden="true" /><span>当前知识库</span></span>
          </span>
          <button type="submit" className="agent-send" aria-label="发送" title="发送" disabled={!chat || sending || !draft.trim()}>
            {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </form>
  );
  const notice = error && chat ? <div className="agent-notice" role="alert"><span>{error}</span>{error.includes('未确认') ? <button type="button" onClick={onRetry}>确认发送结果</button> : null}</div> : null;
  let body: ReactNode;
  if (loading && !chat) {
    body = <div className="agent-skeleton" role="status" aria-label="正在加载会话"><span className="is-user" /><span className="is-line" /><span className="is-short" /></div>;
  } else if (!chat) body = <div className="agent-feedback"><p>{error || '暂时无法连接会话。'}</p><button type="button" onClick={onRetry}>重试</button></div>;
  else if (!messages.length && !sending && !pending) {
    body = <div className="agent-empty">
      <h2>今天想让{title}做什么？</h2>
      {composer}
      {notice}
      {capabilityLabels(tools).length ? <ul className="agent-capabilities" aria-label="可以使用">{capabilityLabels(tools).map(label => <li key={label}>{label}</li>)}</ul> : null}
      <div className="agent-suggested">
        <h3>建议</h3>
        <div className="agent-starters">
          {agentStarters(tools).map(prompt => <button type="button" key={prompt} onClick={() => { onDraftChange(prompt); inputRef.current?.focus(); }}><Sparkles size={14} aria-hidden="true" /><span>{prompt}</span></button>)}
        </div>
      </div>
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
      {sending ? <Working name={title} /> : null}
    </div>;
  }

  return <section className={`agent-view agent-thread${empty ? ' is-empty' : ''}`} aria-label={`${title} 会话`}>
    <div className="agent-scroll" ref={scrollRef} role="log" aria-label="会话记录">
      {body}
    </div>
    <div className="agent-dock">
      {empty ? null : composer}
      {empty ? null : notice}
    </div>
  </section>;
}
