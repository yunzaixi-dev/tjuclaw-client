import { useState } from 'react';
import {
  BookOpen, Brain, CalendarDays, ChevronRight, DoorOpen, FilePen, FilePlus2, FileSearch, FileX2, FolderTree,
  GraduationCap, Image as ImageIcon, ListChecks, MessagesSquare, SquareTerminal, Wrench, type LucideIcon,
} from 'lucide-react';
import type { TurnStep } from '../lib/library';
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

function ToolRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const view = describe(step);
  const Icon = view.icon;
  const hasDetail = Boolean(step.input || step.output);
  return <li className={`agent-step is-tool${step.failed ? ' is-failed' : ''}${open ? ' is-open' : ''}`}>
    <button type="button" aria-expanded={hasDetail ? open : undefined} disabled={!hasDetail} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" />
      <span className="agent-step-label">{view.label}</span>
      {view.detail ? <span className={`agent-step-detail${view.code ? ' is-code' : ''}`}>{view.detail}</span> : null}
      {step.failed ? <span className="agent-step-flag">失败</span> : null}
      {hasDetail ? <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" /> : null}
      <StepStatus status={step.failed ? 'failed' : 'done'} />
    </button>
    {open ? <div className="agent-step-body">
      {step.input ? <><h4>{step.name === 'bash' ? '命令' : '参数'}</h4><pre>{step.name === 'bash' ? step.input : pretty(step.input)}</pre></> : null}
      {step.output ? <><h4>结果</h4><pre>{pretty(step.output, true)}</pre></> : null}
    </div> : null}
  </li>;
}

function ThinkingRow({ step }: { step: TurnStep }) {
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

const VISIBLE_TOOLS = 5;

/**
 * A reply's work, in order: thinking stays thinking (a quiet block that
 * opens on demand) and every tool call is its own visible row. Long runs of
 * tool calls show the first few and fold the rest behind one toggle.
 */
export function AgentSteps({ steps, tools }: { steps?: TurnStep[]; tools?: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const list = steps?.length ? steps : (tools ?? []).map(name => ({ kind: 'tool', name }) as TurnStep);
  if (!list.length) return null;
  const toolIndexes = list.map((step, index) => step.kind === 'tool' ? index : -1).filter(index => index >= 0);
  const hidden = expanded || toolIndexes.length <= VISIBLE_TOOLS + 1 ? new Set<number>() : new Set(toolIndexes.slice(VISIBLE_TOOLS));
  // Thinking after the fold belongs to the folded part too.
  const cut = hidden.size ? Math.min(...hidden) : Infinity;
  const shown = list.map((step, index) => ({ step, index })).filter(({ index }) => index < cut);
  return <ol className="agent-steps-list" aria-label="思考与工具调用">
    {shown.map(({ step, index }) => step.kind === 'thinking'
      ? <ThinkingRow key={index} step={step} />
      : <ToolRow key={index} step={step} />)}
    {hidden.size ? <li className="agent-step is-more">
      <button type="button" onClick={() => setExpanded(true)}>
        <ListChecks size={14} aria-hidden="true" />
        <span className="agent-step-label">显示其余 {list.length - shown.length} 步</span>
      </button>
    </li> : null}
  </ol>;
}
