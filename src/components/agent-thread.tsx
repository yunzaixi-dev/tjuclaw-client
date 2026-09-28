import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowUp, BookOpen, CalendarDays, Check, ChevronDown, Copy, DoorOpen, FileSearch, FileText, GraduationCap,
  Image as ImageIcon, Loader2, MessagesSquare, Settings2, Sparkles, Wrench, type LucideIcon,
} from 'lucide-react';
import { BrandIcon } from './brand-icon';
import { SandboxNotes } from './sandbox-notes';
import { chooseProductModel, getModel, modelDisplayName, type AgentCapabilities, type ChatSession, type ModelStatus } from '../lib/library';
import './agent-thread.css';

const TOOLS: Record<string, { label: string; step: string; icon: LucideIcon }> = {
  campus_semester: { label: '学期', step: '查询当前学期与教学周', icon: CalendarDays },
  campus_timetable: { label: '课表', step: '读取你的课表', icon: CalendarDays },
  campus_exams: { label: '考试安排', step: '查询考试安排', icon: GraduationCap },
  campus_study_rooms: { label: '自习室', step: '查找空闲自习室', icon: DoorOpen },
  campus_forum_posts: { label: '校园论坛', step: '浏览校园论坛', icon: MessagesSquare },
  search_course_materials: { label: '课程资料', step: '检索校园知识库', icon: FileSearch },
  read_image: { label: '看图', step: '查看原图内容', icon: ImageIcon },
  list_tree: { label: '笔记目录', step: '读取笔记目录', icon: FileText },
  create_entry: { label: '新建笔记', step: '新建笔记', icon: FileText },
  update_entry: { label: '修改笔记', step: '修改笔记', icon: FileText },
  delete_entry: { label: '删除笔记', step: '删除笔记', icon: FileText },
};
const toolInfo = (name: string) => TOOLS[name] ?? { label: name, step: name, icon: Wrench };

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

/** Tool calls of one reply, as a collapsible list of finished steps. */
function ToolSteps({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`agent-steps${open ? ' is-open' : ''}`}>
      <button type="button" className="chat-message-tools" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Wrench size={12} aria-hidden="true" />
        <span>使用了 {tools.map(name => toolInfo(name).label).join(' · ')}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? <ol>
        {tools.map((name, index) => {
          const { step, icon: Icon } = toolInfo(name);
          return <li key={`${name}-${index}`}><Icon size={13} aria-hidden="true" /><span>{step}</span><Check size={13} className="agent-step-done" aria-label="已完成" /></li>;
        })}
      </ol> : null}
    </div>
  );
}

/** Elapsed seconds while the Agent works, so a long answer never looks stuck. */
function Thinking() {
  // Mounted when sending starts, so the first render marks the start.
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <div className="agent-thinking" role="status"><span className="agent-thinking-text">正在思考</span><span>{seconds} 秒</span></div>;
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
  if (!status) return null;
  const missing = status.source === 'none';
  const choices = status.source === 'product' ? status.choices ?? [] : [];
  const label = missing ? '未配置模型' : modelDisplayName(status);
  return (
    <div className="agent-model" ref={ref}>
      <button type="button" className={`agent-chip is-button${missing ? ' is-warning' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`模型：${label}`} disabled={busy} onClick={() => setOpen(value => !value)}>
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
        {choices.length || status.source === 'custom' ? <hr /> : null}
        <button type="button" role="menuitem" className="agent-model-manage" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={14} aria-hidden="true" /><span>{missing ? '配置模型…' : '管理模型…'}</span></button>
      </div> : null}
    </div>
  );
}

export function AgentThread({ title, chat, ownerId, entryId, preset, capabilities, loading, error, draft, sending, modelVersion, onDraftChange, onSubmit, onRetry, onManageModels, renderMarkdown }: {
  title: string;
  chat: ChatSession | null;
  ownerId: string;
  entryId: string;
  preset: string;
  capabilities: AgentCapabilities | null;
  loading: boolean;
  error: string;
  draft: string;
  sending: boolean;
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

  const empty = Boolean(chat) && !loading && !messages.length && !sending;
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
            <ModelPill key={modelVersion} onManage={onManageModels} />
            <span className="agent-chip" title="Agent 可以读取和修改当前知识库"><BookOpen size={12} aria-hidden="true" /><span>当前知识库</span></span>
          </span>
          <button type="submit" className="agent-send" aria-label="发送" title="发送" disabled={!chat || sending || !draft.trim()}>
            {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </form>
  );
  const notice = error && chat ? <div className="agent-notice" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>确认发送结果</button></div> : null;
  let body: ReactNode;
  if (loading) body = <div className="agent-feedback"><Loader2 className="animate-spin" size={16} /> 正在加载会话…</div>;
  else if (!chat) body = <div className="agent-feedback"><p>{error || '暂时无法连接会话。'}</p><button type="button" onClick={onRetry}>重试</button></div>;
  else if (!messages.length && !sending) {
    body = <div className="agent-empty">
      <span className="agent-empty-mark"><BrandIcon size={40} /></span>
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
      <header className="agent-thread-head"><span className="agent-thread-avatar"><BrandIcon size={22} /></span><span>{title}</span></header>
      {messages.map((message, index) => message.role === 'user'
        ? <article key={`${message.created_at}-${index}`} className="chat-message user"><p>{message.content}</p></article>
        : <article key={`${message.created_at}-${index}`} className="chat-message assistant">
          <header className="agent-reply-head">
            <span className="agent-avatar"><BrandIcon size={16} /></span><span className="agent-reply-name">{title}</span>
            <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          </header>
          {message.tools?.length ? <ToolSteps tools={message.tools} /> : null}
          <div className="chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
          <div className="agent-reply-actions">
            <button type="button" aria-label="复制回复" title="复制回复" onClick={() => { void navigator.clipboard?.writeText(message.content); setCopiedIndex(index); window.setTimeout(() => setCopiedIndex(current => current === index ? null : current), 1200); }}>
              {copiedIndex === index ? <Check size={13} /> : <Copy size={13} />}<span>{copiedIndex === index ? '已复制' : '复制'}</span>
            </button>
          </div>
        </article>)}
      {/* The draft stays in the composer until the reply is confirmed, so a
          failed send never loses it; the transcript shows the work under way. */}
      {sending ? <Thinking /> : null}
    </div>;
  }

  return <section className={`agent-view agent-thread${empty ? ' is-empty' : ''}`} aria-label={`${title} 会话`}>
    <div className="agent-scroll" ref={scrollRef} role="log" aria-label="会话记录">
      {chat && capabilities?.sandbox ? <SandboxNotes key={`${ownerId}:${chat.id}`} sessionId={chat.id} ownerId={ownerId} entryId={entryId} preset={preset} /> : null}
      {body}
    </div>
    <div className="agent-dock">
      {empty ? null : composer}
      {empty ? null : notice}
    </div>
  </section>;
}
