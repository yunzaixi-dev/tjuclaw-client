import { useState } from 'react';
import {
  Bot,
  Cpu,
  Plus,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Button } from './ui/button';
import '../retro-pixel.css';

export interface BotTemplate {
  id: string;
  name: string;
  role: string;
  avatarSeed: string;
  avatarBg: string;
  avatarFg: string;
  description: string;
  suggestedPrompt: string;
  recommendedTools: string[];
}

export const PRESET_BOT_TEMPLATES: BotTemplate[] = [
  {
    id: 'chief-of-staff',
    name: 'Chief of Staff',
    role: '日程与晨报管家',
    avatarSeed: 'COS',
    avatarBg: '#1f2937',
    avatarFg: '#60a5fa',
    description: '自动读取明日课表与日程，汇编晨间要报与高优事项。',
    suggestedPrompt: '作为我的 Chief of Staff，每天早上 8 点分析天大课程表与待办事项，提取高优先级学习任务并输出晨间简报。',
    recommendedTools: ['google', 'm365', 'notion'],
  },
  {
    id: 'signal-monitor',
    name: 'Signal Monitor',
    role: '校园情报雷达',
    avatarSeed: 'SIG',
    avatarBg: '#0f172a',
    avatarFg: '#34d399',
    description: '持续监听教务处、讲座通知、空闲教室及 RSS 资讯变更。',
    suggestedPrompt: '作为我的 Signal Monitor，实时监控天津大学公共课程平台和教务通知，有重要实验选课或讲座时第一时间提醒我。',
    recommendedTools: ['github', 'slack'],
  },
  {
    id: 'ux-researcher',
    name: 'UX Researcher',
    role: '设计与体验分析师',
    avatarSeed: 'UXR',
    avatarBg: '#312e81',
    avatarFg: '#c084fc',
    description: '深入分析产品交互设计，输出竞品体验对照与可用性报告。',
    suggestedPrompt: '作为我的 UX Researcher，审查当前交互界面流程，指出与业界前沿（如 GrokBot、Raycast）相比的可用性差距。',
    recommendedTools: ['figma', 'notion'],
  },
  {
    id: 'coding-assistant',
    name: 'Code Engineer',
    role: '工程构建与测试审查',
    avatarSeed: 'DEV',
    avatarBg: '#18181b',
    avatarFg: '#fbbf24',
    description: '严格执行编译、单元测试、Git 工作流与沙箱内脚本运行。',
    suggestedPrompt: '作为我的 Code Engineer，使用确定性的 Unix 哲学编写高可靠代码，并通过测试验证每一步逻辑。',
    recommendedTools: ['github', 'jira'],
  },
];

interface BotCreatorProps {
  onSelectTemplate?: (template: BotTemplate) => void;
  onCreateCustom?: (name: string, prompt: string, tools: string[]) => void;
}

export function BotCreator({ onSelectTemplate, onCreateCustom }: BotCreatorProps) {
  const [activeTab, setActiveTab] = useState<'preset' | 'custom'>('preset');
  const [customName, setCustomName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [customRole, setCustomRole] = useState('自定义特化智能体');

  return (
    <div className="bot-creator-view">
      <div className="flex items-center justify-between mb-3">
        <div className="pixel-badge pixel-badge-cyan">
          <Bot size={13} />
          <span>智能体原型工坊 (Bot Matrix)</span>
        </div>
        <div className="cyber-tab-list">
          <button
            type="button"
            className="cyber-tab-item"
            aria-selected={activeTab === 'preset'}
            onClick={() => setActiveTab('preset')}
          >
            <Sparkles size={12} />
            预置原型
          </button>
          <button
            type="button"
            className="cyber-tab-item"
            aria-selected={activeTab === 'custom'}
            onClick={() => setActiveTab('custom')}
          >
            <Plus size={12} />
            定制智能体
          </button>
        </div>
      </div>

      {activeTab === 'preset' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 my-3">
          {PRESET_BOT_TEMPLATES.map(t => (
            <div
              key={t.id}
              className="pixel-card p-4 flex flex-col justify-between hover:border-primary transition-all"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-8 h-8 rounded flex items-center justify-center font-mono font-bold text-xs shadow-inner"
                      style={{ backgroundColor: t.avatarBg, color: t.avatarFg }}
                    >
                      {t.avatarSeed}
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-foreground leading-tight">
                        {t.name}
                      </h3>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {t.role}
                      </span>
                    </div>
                  </div>
                  <span className="pixel-badge text-[9px] bg-muted/60">
                    {t.recommendedTools.length} 个推荐工具
                  </span>
                </div>
                <p className="text-xs text-muted-foreground my-2 leading-relaxed">
                  {t.description}
                </p>
              </div>

              <div className="pt-2 border-t border-border flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[160px]">
                  {t.recommendedTools.join(', ')}
                </span>
                <Button
                  variant="solid"
                  size="default"
                  onClick={() => onSelectTemplate?.(t)}
                  className="pixel-btn-sm pixel-btn-primary"
                >
                  <Zap size={12} />
                  启动会话
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="pixel-card p-4 my-3">
          <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border">
            <div className="w-12 h-12 rounded bg-primary text-primary-foreground flex items-center justify-center font-mono font-bold text-base shadow-sm">
              {customName ? customName.slice(0, 2).toUpperCase() : 'AG'}
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">
                {customName || '未命名智能体'}
              </h3>
              <span className="text-xs text-muted-foreground font-mono">
                {customRole}
              </span>
            </div>
          </div>

          <div className="space-y-3 font-mono text-xs">
            <div>
              <label className="block text-muted-foreground mb-1">
                智能体代号 / 名称
              </label>
              <input
                type="text"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                placeholder="例如：Paper Scout / 选课先锋"
                className="w-full bg-muted/40 border border-border rounded px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="block text-muted-foreground mb-1">
                核心职责定位 (Role Tagline)
              </label>
              <input
                type="text"
                value={customRole}
                onChange={e => setCustomRole(e.target.value)}
                placeholder="例如：论文研读与综述梳理助手"
                className="w-full bg-muted/40 border border-border rounded px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="block text-muted-foreground mb-1">
                系统指令与特化行动提示 (System Prompt)
              </label>
              <textarea
                rows={3}
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                placeholder="定义该智能体行为准则、工具调用权限和输出风格..."
                className="w-full bg-muted/40 border border-border rounded px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="pt-2 flex justify-end">
              <Button
                variant="solid"
                size="default"
                disabled={!customName.trim() || !customPrompt.trim()}
                onClick={() => onCreateCustom?.(customName, customPrompt, [])}
                className="pixel-btn-primary"
              >
                <Cpu size={14} />
                构建并注册智能体
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
