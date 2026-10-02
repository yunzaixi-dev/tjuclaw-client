import { useState } from 'react';
import {
  BookOpen, Brain, CalendarDays, ChevronRight, DoorOpen, FileInput, FilePen, FilePlus2, FileSearch, FileText, FileX2, FolderTree,
  GraduationCap, Image as ImageIcon, ListChecks, MessagesSquare, Search, SquareTerminal, Wrench, type LucideIcon,
} from 'lucide-react';
import type { LiveStatus, TurnStep } from '../lib/library';
import './agent-steps.css';

type Json = Record<string, unknown>;

function parse(value: string | undefined): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Tool results arrive raw (direct path) or wrapped in tjucli's envelope. */
function unwrap(output: string | undefined): unknown {
  const value = parse(output);
  if (value && typeof value === 'object' && 'ok' in (value as Json)) {
    const data = (value as Json).data as Json | undefined;
    if (data && 'result' in data) return typeof data.result === 'string' ? parse(data.result) ?? data.result : data.result;
    return data ?? value;
  }
  return value;
}

const field = (value: unknown, key: string) => value && typeof value === 'object' ? (value as Json)[key] : undefined;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
const quote = (title: string) => title ? `《${title.length > 24 ? `${title.slice(0, 24)}…` : title}》` : '';
const count = (value: unknown, unit: string) => Array.isArray(value) ? `${value.length} ${unit}` : '';
/** The last part of a path, which names the file; the whole path stays in the row's details. */
const fileName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? '';
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i.test(path);

interface ToolView { icon: LucideIcon; label: string; detail?: string; code?: boolean }

/** How each tool reads in the transcript. */
function describe(step: TurnStep): ToolView {
  const input = parse(step.input);
  const output = unwrap(step.output);
  const title = text(field(input, 'title')) || text(field(output, 'title')) || text(field(output, 'Title'));
  switch (step.name) {
    case 'list_tree': return { icon: FolderTree, label: '查看笔记目录', detail: count(output, '个条目') };
    case 'read_entry': return { icon: BookOpen, label: `阅读${quote(title) || '笔记'}` };
    case 'create_entry': return { icon: FilePlus2, label: `新建${quote(title) || '笔记'}` };
    case 'update_entry': return { icon: FilePen, label: `修改${quote(title) || '笔记'}` };
    case 'delete_entry': return { icon: FileX2, label: '删除笔记' };
    case 'search_course_materials': {
      const query = text(field(input, 'query'));
      return { icon: FileSearch, label: `检索课程资料${query ? `「${query}」` : ''}`, detail: count(field(output, 'hits') ?? output, '条结果') };
    }
    case 'campus_timetable': return { icon: CalendarDays, label: '读取课表' };
    case 'campus_exams': return { icon: GraduationCap, label: '查询考试安排' };
    case 'campus_study_rooms': return { icon: DoorOpen, label: '查找空闲自习室' };
    case 'campus_forum_posts': return { icon: MessagesSquare, label: '浏览校园论坛' };
    case 'campus_semester': return { icon: CalendarDays, label: '查询学期与教学周' };
    case 'read_image': return { icon: ImageIcon, label: '识别图片' };
    case 'tools_list': return { icon: ListChecks, label: '查看可用工具' };
    // The tools Pi runs inside its own workspace.
    case 'read': {
      const path = text(field(input, 'path'));
      return isImage(path) ? { icon: ImageIcon, label: '查看图片', detail: fileName(path), code: true }
        : { icon: FileText, label: '读取文件', detail: fileName(path), code: true };
    }
    case 'write': return { icon: FileInput, label: '写入文件', detail: fileName(text(field(input, 'path'))), code: true };
    case 'edit': return { icon: FilePen, label: '编辑文件', detail: fileName(text(field(input, 'path'))), code: true };
    case 'grep': return { icon: Search, label: '搜索内容', detail: text(field(input, 'pattern')), code: true };
    case 'find': return { icon: FileSearch, label: '查找文件', detail: text(field(input, 'pattern')), code: true };
    case 'ls': return { icon: FolderTree, label: '列出目录', detail: text(field(input, 'path')), code: true };
    case 'bash': {
      const command = (step.input ?? '').split('\n')[0];
      return { icon: SquareTerminal, label: '运行命令', detail: command.length > 60 ? `${command.slice(0, 60)}…` : command, code: true };
    }
    default: return { icon: Wrench, label: step.name || '工具' };
  }
}

function pretty(value: string | undefined, envelope = false) {
  const parsed = envelope ? unwrap(value) : parse(value);
  const out = parsed === undefined ? value ?? '' : JSON.stringify(parsed, null, 2);
  return out.length > 4000 ? `${out.slice(0, 4000)}\n…` : out;
}

/** A tool call's state: a turning ring while it runs, a check drawn in when done. */
export function StepStatus({ status }: { status: 'running' | 'done' | 'failed' }) {
  return <span className={`agent-step-status is-${status}`} role="img" aria-label={status === 'running' ? '进行中' : status === 'done' ? '已完成' : '失败'}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle className="ring" cx="8" cy="8" r="6.25" />
      {status === 'done' ? <path className="mark" d="M5 8.3 7.1 10.3 11 6" /> : null}
      {status === 'failed' ? <path className="mark" d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2" /> : null}
    </svg>
  </span>;
}

/** How a tool call reads, for rows outside this module (the running turn). */
export function toolView(step: TurnStep) {
  return describe(step);
}

/**
 * The lines a file change adds and removes. While a file is still being
 * written only the lines so far are known.
 */
function Changes({ added = 0, removed = 0, lines = 0 }: { added?: number; removed?: number; lines?: number }) {
  if (!added && !removed && !lines) return null;
  const label = lines ? `已写入 ${lines} 行` : [added ? `新增 ${added} 行` : '', removed ? `删除 ${removed} 行` : ''].filter(Boolean).join('，');
  return <span className="agent-step-changes" role="img" aria-label={label}>
    {lines ? <span className="is-added" aria-hidden="true">+{lines}</span> : null}
    {added ? <span className="is-added" aria-hidden="true">+{added}</span> : null}
    {removed ? <span className="is-removed" aria-hidden="true">−{removed}</span> : null}
  </span>;
}

/** A unified or numbered diff with its added and removed lines marked. */
function Diff({ text: value }: { text: string }) {
  return <pre className="agent-step-diff">{value.split('\n').map((line, index) => {
    const kind = /^\+(?!\+\+)/.test(line) ? ' is-added' : /^-(?!--)/.test(line) ? ' is-removed' : '';
    return <span key={index} className={`agent-step-diff-line${kind}`}>{line}{'\n'}</span>;
  })}</pre>;
}

const looksLikeDiff = (value: string) => /^[+-]\s*\d+\s/m.test(value) || /^@@ /m.test(value);

/**
 * One tool call. A saved step has ended; a step of the running turn says
 * with `status` whether its arguments are still being written, it runs, or
 * it ended, and with `lines` how much of a file has been written.
 */
export function ToolRow({ step, status, lines }: { step: TurnStep; status?: LiveStatus; lines?: number }) {
  const [open, setOpen] = useState(false);
  const view = describe(step);
  const Icon = view.icon;
  const hasDetail = Boolean(step.input || step.output);
  const failed = step.failed || status === 'failed';
  const shown = failed ? 'failed' : status === 'writing' || status === 'running' ? 'running' : 'done';
  return <li className={`agent-step is-tool${failed ? ' is-failed' : ''}${open ? ' is-open' : ''}${status ? ` is-live is-${status}` : ''}`}>
    <button type="button" aria-expanded={hasDetail ? open : undefined} disabled={!hasDetail} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" />
      <span className="agent-step-label">{view.label}</span>
      {view.detail ? <span className={`agent-step-detail${view.code ? ' is-code' : ''}`}>{view.detail}</span> : null}
      {failed ? null : <Changes added={step.added} removed={step.removed} lines={lines} />}
      {failed ? <span className="agent-step-flag">失败</span> : null}
      {hasDetail ? <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" /> : null}
      <StepStatus status={shown} />
    </button>
    {open ? <div className="agent-step-body">
      {step.input ? <><h4>{step.name === 'bash' ? '命令' : '参数'}</h4><pre>{step.name === 'bash' ? step.input : pretty(step.input)}</pre></> : null}
      {step.output ? <><h4>{step.name === 'edit' && looksLikeDiff(step.output) ? '改动' : '结果'}</h4>
        {step.name === 'edit' && looksLikeDiff(step.output) ? <Diff text={step.output} /> : <pre>{pretty(step.output, true)}</pre>}</> : null}
    </div> : null}
  </li>;
}

export function ThinkingRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const thought = (step.text ?? '').trim();
  return <li className={`agent-step is-thinking${open ? ' is-open' : ''}`}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Brain size={14} aria-hidden="true" />
      <span className="agent-step-label">思考过程</span>
      {!open ? <span className="agent-step-detail">{thought.replace(/\s+/g, ' ')}</span> : null}
      <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" />
    </button>
    {open ? <p className="agent-step-thought">{thought}</p> : null}
  </li>;
}

/** What the model said before it went on to call tools, set like the reply itself. */
export function SaidText({ text: value, renderMarkdown }: { text: string; renderMarkdown?: (markdown: string) => string }) {
  return renderMarkdown ? <div className="agent-step-said chat-message-content markdown-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
    : <p className="agent-step-said chat-message-content">{value}</p>;
}

/**
 * Splits a turn's steps where the model spoke: each run of thinking and tool
 * calls is one list with its own connecting line, and the words between two
 * runs stand between them like the reply's own text.
 */
export function groupSteps<T extends { kind: string; said?: boolean }>(steps: T[]): ({ said: T; index: number } | { rows: { step: T; index: number }[] })[] {
  const groups: ({ said: T; index: number } | { rows: { step: T; index: number }[] })[] = [];
  steps.forEach((step, index) => {
    // A saved step marks what was said; the running turn has a kind for it.
    if (step.kind === 'text' || step.said) { groups.push({ said: step, index }); return; }
    const open = groups[groups.length - 1];
    if (open && 'rows' in open) open.rows.push({ step, index });
    else groups.push({ rows: [{ step, index }] });
  });
  return groups;
}

const VISIBLE_TOOLS = 5;

/**
 * A reply's work, in order: thinking stays thinking (a quiet block that
 * opens on demand), what the model said on the way reads like the reply, and
 * every tool call is its own visible row. Long runs of tool calls show the
 * first few and fold the rest behind one toggle, unless the reply was just
 * written in front of the reader, who has already seen every step.
 */
export function AgentSteps({ steps, tools, renderMarkdown, unfolded = false }: {
  steps?: TurnStep[];
  tools?: string[];
  renderMarkdown?: (markdown: string) => string;
  unfolded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = steps?.length ? steps : (tools ?? []).map(name => ({ kind: 'tool', name }) as TurnStep);
  if (!list.length) return null;
  const toolIndexes = list.map((step, index) => step.kind === 'tool' ? index : -1).filter(index => index >= 0);
  const hidden = unfolded || expanded || toolIndexes.length <= VISIBLE_TOOLS + 1 ? new Set<number>() : new Set(toolIndexes.slice(VISIBLE_TOOLS));
  // Thinking and text after the fold belong to the folded part too.
  const cut = hidden.size ? Math.min(...hidden) : Infinity;
  const shown = list.map((step, index) => ({ step, index })).filter(({ index }) => index < cut);
  const more = hidden.size ? <li className="agent-step is-more">
    <button type="button" onClick={() => setExpanded(true)}>
      <ListChecks size={14} aria-hidden="true" />
      <span className="agent-step-label">显示其余 {list.length - shown.length} 步</span>
    </button>
  </li> : null;
  const groups = groupSteps(shown.map(({ step }) => step));
  return <>{groups.map((group, position) => 'said' in group
    ? <SaidText key={`said:${group.index}`} text={group.said.text ?? ''} renderMarkdown={renderMarkdown} />
    : <ol key={`rows:${group.rows[0].index}`} className="agent-steps-list" aria-label="思考与工具调用">
      {group.rows.map(({ step, index }) => step.kind === 'thinking' ? <ThinkingRow key={index} step={step} /> : <ToolRow key={index} step={step} />)}
      {position === groups.length - 1 ? more : null}
    </ol>)}
    {/* The fold begins right after something the model said. */}
    {more && groups.length && 'said' in groups[groups.length - 1] ? <ol className="agent-steps-list" aria-label="思考与工具调用">{more}</ol> : null}
  </>;
}
