import { useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Plus,
  Server,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from 'lucide-react';
import { Button } from './ui/button';
import '../retro-pixel.css';

export interface RoutineItem {
  id: string;
  title: string;
  schedule: string;
  botName: string;
  enabled: boolean;
  lastRunAt?: string;
  prompt: string;
}

export interface McpServerItem {
  id: string;
  name: string;
  endpoint: string;
  status: 'connected' | 'idle' | 'auth_required';
  toolsCount: number;
}

const INITIAL_ROUTINES: RoutineItem[] = [
  {
    id: 'r-1',
    title: '每周天大课程与自习日程通报',
    schedule: '每周一 07:30',
    botName: 'Chief of Staff',
    enabled: true,
    lastRunAt: '2026-09-08 07:30:00',
    prompt: '拉取天大教务系统本周课程日程，对比卫津路/北洋园校区空闲教室，输出周日程规划。',
  },
  {
    id: 'r-2',
    title: '北洋网盘与共享课程资料变更监控',
    schedule: '每日 21:00',
    botName: 'Signal Monitor',
    enabled: true,
    lastRunAt: '2026-09-11 21:00:00',
    prompt: '检查订阅的公共资料库与教务网站更新，提取新增课件并推送摘要。',
  },
];

const INITIAL_MCP_SERVERS: McpServerItem[] = [
  {
    id: 'mcp-calendar',
    name: 'Google Calendar Remote MCP',
    endpoint: 'https://mcp.google.com/calendar/v1',
    status: 'connected',
    toolsCount: 6,
  },
  {
    id: 'mcp-tjucli',
    name: 'TJU Campus Tool Server (tjucli)',
    endpoint: 'http://127.0.0.1:8080/mcp',
    status: 'connected',
    toolsCount: 14,
  },
];

export function RoutinesManager() {
  const [routines, setRoutines] = useState<RoutineItem[]>(INITIAL_ROUTINES);
  const [mcpServers] = useState<McpServerItem[]>(INITIAL_MCP_SERVERS);
  const [showAddRoutine, setShowAddRoutine] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSchedule, setNewSchedule] = useState('每日 08:00');
  const [newPrompt, setNewPrompt] = useState('');

  function toggleRoutine(id: string) {
    setRoutines(prev =>
      prev.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  }

  function deleteRoutine(id: string) {
    setRoutines(prev => prev.filter(r => r.id !== id));
  }

  function handleAddRoutine() {
    if (!newTitle.trim()) return;
    const item: RoutineItem = {
      id: `r-${Date.now()}`,
      title: newTitle.trim(),
      schedule: newSchedule,
      botName: 'Custom Agent',
      enabled: true,
      prompt: newPrompt.trim() || '按时执行日常计划',
    };
    setRoutines(prev => [item, ...prev]);
    setNewTitle('');
    setNewPrompt('');
    setShowAddRoutine(false);
  }

  return (
    <div className="routines-manager-view space-y-4">
      {/* MCP Remote Servers Card */}
      <div className="pixel-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-primary" />
            <h3 className="text-xs font-bold font-mono tracking-tight text-foreground">
              MCP 工具服务器连接状态 (Active Providers)
            </h3>
          </div>
          <span className="pixel-badge pixel-badge-green text-[10px]">
            {mcpServers.filter(s => s.status === 'connected').length} 在线
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {mcpServers.map(s => (
            <div
              key={s.id}
              className="bg-muted/30 border border-border rounded p-2.5 flex items-center justify-between text-xs font-mono"
            >
              <div>
                <span className="font-bold block text-foreground">{s.name}</span>
                <span className="text-[10px] text-muted-foreground truncate block max-w-[200px]">
                  {s.endpoint}
                </span>
              </div>
              <div className="text-right">
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                  <CheckCircle2 size={11} /> 已连接
                </span>
                <span className="block text-[9px] text-muted-foreground">
                  {s.toolsCount} 项能力注入
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Routines Scheduler List */}
      <div className="pixel-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-primary" />
            <h3 className="text-xs font-bold font-mono tracking-tight text-foreground">
              定时例行公事 (Autonomous Routines)
            </h3>
          </div>
          <Button
            variant="solid"
            size="default"
            onClick={() => setShowAddRoutine(!showAddRoutine)}
            className="pixel-btn-sm pixel-btn-primary font-mono text-[11px]"
          >
            <Plus size={11} /> 新建定时
          </Button>
        </div>

        {showAddRoutine && (
          <div className="bg-muted/40 border border-border rounded p-3 mb-3 space-y-2 text-xs font-mono">
            <h4 className="font-bold text-foreground">创建新例行公事 (New Routine)</h4>
            <div>
              <label className="block text-muted-foreground text-[10px] mb-1">
                例行名称
              </label>
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="例如：每日清晨学术论文跟踪"
                className="w-full bg-background border border-border rounded px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-muted-foreground text-[10px] mb-1">
                触发周期与时刻
              </label>
              <select
                value={newSchedule}
                onChange={e => setNewSchedule(e.target.value)}
                className="w-full bg-background border border-border rounded px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="每日 08:00">每日 08:00 (早报模式)</option>
                <option value="每周一 07:30">每周一 07:30 (周课表复核)</option>
                <option value="每日 21:00">每日 21:00 (晚间归档总结)</option>
                <option value="工作日 12:00">工作日 12:00 (午间提醒)</option>
              </select>
            </div>
            <div>
              <label className="block text-muted-foreground text-[10px] mb-1">
                例行行动提示 (Task Prompt)
              </label>
              <textarea
                rows={2}
                value={newPrompt}
                onChange={e => setNewPrompt(e.target.value)}
                placeholder="定义该定时到达时智能体自主执行的操作..."
                className="w-full bg-background border border-border rounded px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="default"
                onClick={() => setShowAddRoutine(false)}
                className="text-[11px]"
              >
                取消
              </Button>
              <Button
                variant="solid"
                size="default"
                onClick={handleAddRoutine}
                className="pixel-btn-sm pixel-btn-primary"
              >
                保存例行计划
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {routines.map(r => (
            <div
              key={r.id}
              className={`border rounded p-3 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                r.enabled
                  ? 'border-border bg-card'
                  : 'border-border/40 bg-muted/20 opacity-60'
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs text-foreground">{r.title}</span>
                  <span className="pixel-badge text-[9px] bg-muted/60 font-mono">
                    {r.botName}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
                  <span className="flex items-center gap-1">
                    <Calendar size={11} /> {r.schedule}
                  </span>
                  {r.lastRunAt && <span>上次触发: {r.lastRunAt}</span>}
                </div>
                <p className="text-[11px] text-muted-foreground line-clamp-1">
                  {r.prompt}
                </p>
              </div>

              <div className="flex items-center gap-2 self-end md:self-center">
                <button
                  type="button"
                  onClick={() => toggleRoutine(r.id)}
                  className="text-foreground hover:text-primary transition-colors"
                  aria-label={r.enabled ? '停用此例行' : '启用此例行'}
                >
                  {r.enabled ? (
                    <ToggleRight size={22} className="text-emerald-500" />
                  ) : (
                    <ToggleLeft size={22} className="text-muted-foreground" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => deleteRoutine(r.id)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                  aria-label="删除此例行"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
