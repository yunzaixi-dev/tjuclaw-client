/** Composer commands this page can run itself. Terminal-only Pi commands are omitted. */

export type PiAction = 'new' | 'model' | 'thinking' | 'copy' | 'session' | 'resume';

export interface PiCommand {
  name: string;
  label: string;
  hint: string;
  action?: PiAction;
  available: boolean;
}

export const PI_COMMANDS: PiCommand[] = [
  { name: '/new', label: '新对话', hint: '开始一段新的会话', action: 'new', available: true },
  { name: '/model', label: '模型', hint: '打开模型设置', action: 'model', available: true },
  { name: '/thinking', label: '思考强度', hint: '在自动、快速、深入之间切换', action: 'thinking', available: true },
  { name: '/copy', label: '复制上一条', hint: '复制上一条助手回复', action: 'copy', available: true },
  { name: '/session', label: '会话信息', hint: '查看当前会话编号和消息数', action: 'session', available: true },
  { name: '/resume', label: '历史会话', hint: '打开会话列表', action: 'resume', available: true },
];

/** The command token being typed, or null when the draft is an ordinary message. */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/') || draft.includes('\n')) return null;
  const token = draft.trim().split(/\s+/)[0] ?? '';
  if (!token.startsWith('/')) return null;
  const known = PI_COMMANDS.some(command => command.name === token);
  if (draft.trim() === token || known) return token;
  return null;
}

export function matchingCommands(query: string): PiCommand[] {
  const needle = query.toLowerCase();
  return PI_COMMANDS.filter(command => command.available && command.name.startsWith(needle));
}
