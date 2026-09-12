import { useState } from 'react';
import {
  Check,
  Layers,
  Search,
  Sparkles,
} from 'lucide-react';
import { Button } from './ui/button';
import '../retro-pixel.css';

export interface DailyTool {
  id: string;
  name: string;
  category: string;
  iconBg: string;
  iconFg: string;
  initials: string;
  description: string;
  connected?: boolean;
}

export const DAILY_TOOLS_CATALOG: DailyTool[] = [
  { id: 'google', name: 'Google Workspace', category: 'Productivity', iconBg: '#4285F4', iconFg: '#ffffff', initials: 'G', description: 'Calendar, Drive, Docs & Gmail API' },
  { id: 'slack', name: 'Slack', category: 'Communication', iconBg: '#4A154B', iconFg: '#ffffff', initials: '#', description: 'Channels, threads, message dispatch' },
  { id: 'notion', name: 'Notion', category: 'Workspace', iconBg: '#000000', iconFg: '#ffffff', initials: 'N', description: 'Databases, pages, syllabus sync' },
  { id: 'salesforce', name: 'Salesforce', category: 'Enterprise', iconBg: '#00A1E0', iconFg: '#ffffff', initials: 'SF', description: 'Customer & partner management' },
  { id: 'm365', name: 'Microsoft 365', category: 'Productivity', iconBg: '#D83B01', iconFg: '#ffffff', initials: 'MS', description: 'Teams, Outlook, OneDrive sync' },
  { id: 'linkedin', name: 'LinkedIn', category: 'Social', iconBg: '#0A66C2', iconFg: '#ffffff', initials: 'in', description: 'Campus alumni & career telemetry' },
  { id: 'zoom', name: 'Zoom', category: 'Communication', iconBg: '#2D8CFF', iconFg: '#ffffff', initials: 'Z', description: 'Webinars, meeting transcripts' },
  { id: 'github', name: 'GitHub', category: 'Developer', iconBg: '#24292E', iconFg: '#ffffff', initials: 'GH', description: 'Repos, PR reviews, Actions runners' },
  { id: 'jira', name: 'Jira Software', category: 'Project', iconBg: '#0052CC', iconFg: '#ffffff', initials: 'J', description: 'Issue tracking & sprint kanban' },
  { id: 'figma', name: 'Figma', category: 'Design', iconBg: '#F24E1E', iconFg: '#ffffff', initials: 'F', description: 'Design files, tokens, UI exports' },
  { id: 'hubspot', name: 'HubSpot', category: 'Enterprise', iconBg: '#FF7A59', iconFg: '#ffffff', initials: 'HS', description: 'Outreach & marketing automation' },
  { id: 'canva', name: 'Canva', category: 'Design', iconBg: '#00C4CC', iconFg: '#ffffff', initials: 'C', description: 'Poster design, presentation assets' },
];

interface DailyToolsSelectorProps {
  initialSelected?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  onContinue?: (selectedIds: string[]) => void;
}

export function DailyToolsSelector({
  initialSelected = ['google', 'github'],
  onSelectionChange,
  onContinue,
}: DailyToolsSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [search, setSearch] = useState('');

  function toggleTool(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
    onSelectionChange?.(Array.from(next));
  }

  const filtered = DAILY_TOOLS_CATALOG.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.category.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="daily-tools-view">
      <div className="daily-tools-header">
        <div className="flex items-center justify-between mb-2">
          <div className="pixel-badge pixel-badge-cyan">
            <Layers size={12} />
            <span>日常连接器矩阵 (12 Tools)</span>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            已选择: {selected.size} / {DAILY_TOOLS_CATALOG.length}
          </span>
        </div>
        <h2 className="text-xl font-bold tracking-tight text-foreground">
          你每天使用哪些工具？
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          接入日常生产力与开发者工具，让 TJUClaw 智能体能够读取上下文并执行跨平台任务。
        </p>
      </div>

      <div className="relative my-4">
        <Search className="absolute left-3 top-2.5 text-muted-foreground" size={15} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索连接器 (如 Google, GitHub, Notion)..."
          className="w-full bg-muted/40 border border-border rounded-md pl-9 pr-4 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* 4x3 Tool Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 my-4">
        {filtered.map(tool => {
          const isSelected = selected.has(tool.id);
          return (
            <button
              key={tool.id}
              type="button"
              onClick={() => toggleTool(tool.id)}
              className={`pixel-card pixel-card-interactive p-3.5 flex flex-col items-center justify-between text-center transition-all ${
                isSelected ? 'pixel-card-active' : ''
              }`}
              style={{ minHeight: '110px' }}
            >
              <div className="w-full flex justify-between items-start mb-2">
                <span className="text-[10px] uppercase font-mono text-muted-foreground">
                  {tool.category}
                </span>
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    isSelected
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/30 bg-background'
                  }`}
                >
                  {isSelected && <Check size={11} strokeWidth={3} />}
                </span>
              </div>

              <div
                className="w-9 h-9 rounded-md flex items-center justify-center font-bold text-sm shadow-sm"
                style={{ backgroundColor: tool.iconBg, color: tool.iconFg }}
              >
                {tool.initials}
              </div>

              <div className="mt-2 w-full">
                <span className="text-xs font-semibold block truncate text-foreground">
                  {tool.name}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border mt-4">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Sparkles size={12} className="text-primary" />
          基于 OAuth2 & MCP 协议，无明文凭据存储
        </span>
        <div className="flex gap-2">
          {selected.size === 0 ? (
            <Button
              variant="ghost"
              size="default"
              onClick={() => onContinue?.([])}
              className="text-xs font-mono"
            >
              跳过 (稍后配置)
            </Button>
          ) : (
            <Button
              variant="solid"
              size="default"
              onClick={() => onContinue?.(Array.from(selected))}
              className="pixel-btn-primary text-xs font-mono"
            >
              确认并连接 ({selected.size})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
