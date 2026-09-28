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
    </button>
    {open ? <div className="agent-step-body">
      {step.input ? <><h4>{step.name === 'bash' ? '命令' : '参数'}</h4><pre>{step.name === 'bash' ? step.input : pretty(step.input)}</pre></> : null}
      {step.output ? <><h4>结果</h4><pre>{pretty(step.output, true)}</pre></> : null}
    </div> : null}
  </li>;
}

function ThinkingRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  return <li className={`agent-step is-thinking${open ? ' is-open' : ''}`}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Brain size={14} aria-hidden="true" />
      <span className="agent-step-label">思考</span>
      {!open ? <span className="agent-step-detail">{(step.text ?? '').replace(/\s+/g, ' ')}</span> : null}
      <ChevronRight size={13} className="agent-step-chevron" aria-hidden="true" />
    </button>
    {open ? <p className="agent-step-thought">{step.text}</p> : null}
  </li>;
}

const SHORT: Record<string, string> = {
  campus_semester: '学期', campus_timetable: '课表', campus_exams: '考试安排', campus_study_rooms: '自习室',
  campus_forum_posts: '校园论坛', search_course_materials: '课程资料', read_image: '看图', list_tree: '笔记目录',
  read_entry: '读笔记', create_entry: '新建笔记', update_entry: '修改笔记', delete_entry: '删除笔记',
  bash: '命令', tools_list: '工具列表',
};

/** A reply's chain of thought and tool calls, collapsed to one summary line. */
export function AgentSteps({ steps, tools }: { steps?: TurnStep[]; tools?: string[] }) {
  const [open, setOpen] = useState(false);
  const list = steps?.length ? steps : (tools ?? []).map(name => ({ kind: 'tool', name }) as TurnStep);
  if (!list.length) return null;
  const toolCount = list.filter(step => step.kind === 'tool').length;
  const thought = list.some(step => step.kind === 'thinking');
  const failed = list.some(step => step.failed);
  const names = [...new Set(list.filter(step => step.kind === 'tool').map(step => SHORT[step.name ?? ''] ?? step.name ?? '工具'))];
  const used = names.length && names.length <= 3 ? `使用了 ${names.join(' · ')}` : toolCount ? `调用了 ${toolCount} 次工具` : '';
  const summary = [thought ? '已思考' : '', used].filter(Boolean).join(' · ');
  return <div className={`agent-steps-block${open ? ' is-open' : ''}`}>
    <button type="button" className="agent-steps-summary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>{summary}{failed ? ' · 有步骤失败' : ''}</span>
      <ChevronRight size={13} aria-hidden="true" />
    </button>
    {open ? <ol className="agent-steps-list" aria-label="思考与工具调用">
      {list.map((step, index) => step.kind === 'thinking'
        ? <ThinkingRow key={index} step={step} />
        : <ToolRow key={index} step={step} />)}
    </ol> : null}
  </div>;
}
