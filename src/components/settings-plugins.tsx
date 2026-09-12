import { useState } from 'react';
import {
  Shield,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { Button } from './ui/button';
import '../retro-pixel.css';

interface PluginItem {
  id: string;
  name: string;
  category: string;
  description: string;
  installed: boolean;
}

const PLUGINS_CATALOG: PluginItem[] = [
  { id: 'p-browserbase', name: 'Browserbase', category: 'Automation', description: '托管式浏览器执行与无头沙箱调度环境', installed: true },
  { id: 'p-composio', name: 'Composio Toolset', category: 'Integration', description: '连接 100+ 生产力工具的标准授权协议适配器', installed: true },
  { id: 'p-context7', name: 'Context7 Memory', category: 'Memory', description: '高内聚向量长短期记忆与语义事实召回网关', installed: false },
  { id: 'p-aws', name: 'AWS Bedrock Agents', category: 'Compute', description: '云端弹性大模型与特化推理集群对接', installed: false },
];

export function SettingsAndPluginsView() {
  const [autoReview, setAutoReview] = useState(true);
  const [autoTimezone, setAutoTimezone] = useState(true);
  const [timezone] = useState('Asia/Shanghai (CST)');
  const [plugins, setPlugins] = useState<PluginItem[]>(PLUGINS_CATALOG);
  const [activeTab, setActiveTab] = useState<'settings' | 'plugins'>('settings');

  function togglePlugin(id: string) {
    setPlugins(prev =>
      prev.map(p => (p.id === id ? { ...p, installed: !p.installed } : p))
    );
  }

  return (
    <div className="pixel-card p-4 space-y-4 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-primary" />
          <h3 className="font-bold text-foreground text-sm">
            安全策略与扩展配置 (Security & Plugins)
          </h3>
        </div>
        <div className="cyber-tab-list">
          <button
            type="button"
            className="cyber-tab-item"
            aria-selected={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
          >
            安全与审计
          </button>
          <button
            type="button"
            className="cyber-tab-item"
            aria-selected={activeTab === 'plugins'}
            onClick={() => setActiveTab('plugins')}
          >
            插件市场 ({plugins.filter(p => p.installed).length})
          </button>
        </div>
      </div>

      {activeTab === 'settings' ? (
        <div className="space-y-4">
          {/* Auto-Review Setting Row */}
          <div className="border border-border rounded-md p-3.5 bg-card flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-bold text-foreground text-xs">
                  自动审查与高危拦截 (Auto-Review Guard)
                </span>
                <span className={`pixel-badge ${autoReview ? 'pixel-badge-green' : 'border-amber-500 text-amber-500'}`}>
                  {autoReview ? '已严加防护' : '已放行测试'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                对敏感 Shell 指令、高危 MCP 工具调用与虚拟机沙箱外部网络访问进行人工二次确认，杜绝未授权破坏操作。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAutoReview(!autoReview)}
              className="mt-1 transition-colors"
              aria-label={autoReview ? '关闭自动审查' : '开启自动审查'}
            >
              {autoReview ? (
                <ToggleRight size={26} className="text-emerald-500" />
              ) : (
                <ToggleLeft size={26} className="text-muted-foreground" />
              )}
            </button>
          </div>

          {/* Timezone Setting */}
          <div className="border border-border rounded-md p-3.5 bg-card flex items-center justify-between">
            <div>
              <span className="font-bold text-foreground text-xs block">
                沙箱时区与环境对齐 (Time Zone Sync)
              </span>
              <span className="text-[11px] text-muted-foreground">
                智能体远程沙箱与本地客户端保持时区一致 ({timezone})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAutoTimezone(!autoTimezone)}
              className="transition-colors"
            >
              {autoTimezone ? (
                <ToggleRight size={24} className="text-emerald-500" />
              ) : (
                <ToggleLeft size={24} className="text-muted-foreground" />
              )}
            </button>
          </div>

          {/* Identity & Scope Info */}
          <div className="bg-muted/30 border border-border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Ory Kratos 身份鉴权：</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1">
                <ShieldCheck size={13} /> 企业级同源安全 Cookie
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">沙箱容器执行权：</span>
              <span className="text-foreground font-semibold">
                腾讯云 Agent Sandbox 微隔离
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {plugins.map(p => (
              <div
                key={p.id}
                className="border border-border rounded-md p-3 bg-card flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-foreground text-xs">
                      {p.name}
                    </span>
                    <span className="pixel-badge text-[9px] bg-muted/60">
                      {p.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground my-1.5 leading-relaxed">
                    {p.description}
                  </p>
                </div>

                <div className="pt-2 border-t border-border/50 flex justify-end">
                  <Button
                    variant={p.installed ? 'ghost' : 'solid'}
                    size="default"
                    onClick={() => togglePlugin(p.id)}
                    className={`pixel-btn-sm font-mono text-[10px] ${
                      p.installed ? '' : 'pixel-btn-primary'
                    }`}
                  >
                    {p.installed ? '已接入 (卸载)' : '+ 接入技能'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
