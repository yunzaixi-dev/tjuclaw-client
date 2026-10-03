import { Blocks, Plug, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { builtInPlugins, type BuiltInPluginId } from './workspace-plugins';
import { SkillSettings } from './skill-settings';
import { McpSettings } from './mcp-settings';
import './extensions-center.css';

export type ExtensionsTab = 'plugins' | 'mcp';

/**
 * Plugins and MCP services in one place of their own, opened from the
 * sidebar: built-in features and reviewed skills on one tab, outside
 * services for the Agent on the other.
 */
export function ExtensionsCenter({ open, tab, onTabChange, onOpenChange, onOpenPlugin }: {
  open: boolean;
  tab: ExtensionsTab;
  onTabChange: (tab: ExtensionsTab) => void;
  onOpenChange: (open: boolean) => void;
  onOpenPlugin: (id: BuiltInPluginId) => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="extensions-center" onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus(); }}>
      <header className="extensions-head">
        <div className="extensions-title">
          <DialogTitle>{tab === 'plugins' ? '插件' : 'MCP 服务'}</DialogTitle>
          <DialogDescription>{tab === 'plugins' ? '工作区自带的功能，以及可以按需为 Agent 启用的技能。' : '为 Agent 接入外部服务的工具；密钥只保存在服务器上。'}</DialogDescription>
        </div>
        <div className="extensions-tabs" role="tablist" aria-label="扩展类型">
          <button type="button" role="tab" aria-selected={tab === 'plugins'} onClick={() => onTabChange('plugins')}><Blocks size={15} aria-hidden="true" />插件</button>
          <button type="button" role="tab" aria-selected={tab === 'mcp'} onClick={() => onTabChange('mcp')}><Plug size={15} aria-hidden="true" />MCP</button>
        </div>
        <DialogClose asChild><button type="button" className="extensions-close" aria-label="关闭"><X size={17} /></button></DialogClose>
      </header>
      <div className="extensions-body" role="tabpanel">
        {tab === 'plugins' ? <>
          <h3>内置</h3>
          <div className="mcp-catalog">
            {builtInPlugins.filter(plugin => plugin.id !== 'editor').map(plugin => <article key={plugin.id} className="mcp-card" aria-labelledby={`builtin-${plugin.id}`}>
              <header><strong id={`builtin-${plugin.id}`}>{plugin.name}</strong><span>内置</span></header>
              <p>{plugin.description}</p>
              <footer><span /><button type="button" className="settings-action-button" onClick={() => onOpenPlugin(plugin.id)}>{plugin.action}</button></footer>
            </article>)}
          </div>
          <SkillSettings />
        </> : <McpSettings />}
      </div>
    </DialogContent>
  </Dialog>;
}
