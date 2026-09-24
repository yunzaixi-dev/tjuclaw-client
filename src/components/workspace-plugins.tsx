import { Blocks, Brain, FileText, Network } from 'lucide-react';

export const builtInPlugins = [
  {
    id: 'editor',
    name: 'Markdown 编辑器',
    description: '即时预览、格式工具栏与文档大纲。',
    details: ['CodeMirror 6 即时预览', 'Markdown 格式工具栏', '文档大纲'],
    action: '打开资料夹',
    Icon: FileText,
  },
  {
    id: 'graph',
    name: '知识图谱',
    description: '查看笔记之间的双向链接。',
    details: ['识别 [[笔记名称]] 链接', '从节点跳转至笔记'],
    action: '打开知识图谱',
    Icon: Network,
  },
  {
    id: 'flashcards',
    name: '记忆闪卡',
    description: '在浏览器中整理卡片，并导出 Anki 可导入的 TSV。',
    details: ['编辑卡片正面、背面与标签', '导出 TSV 文件'],
    action: '打开记忆闪卡',
    Icon: Brain,
  },
] as const;

export type BuiltInPluginId = (typeof builtInPlugins)[number]['id'];

export function WorkspacePlugins({ activeId, onOpen }: { activeId: BuiltInPluginId; onOpen: (id: BuiltInPluginId) => void }) {
  const plugin = builtInPlugins.find(item => item.id === activeId) ?? builtInPlugins[0];
  const Icon = plugin.Icon;

  return <section className="workspace-plugins" aria-label="插件">
    <div className="plugin-detail">
      <div className="plugin-detail-heading">
        <div className="plugin-detail-icon"><Icon size={26} /></div>
        <div><span className="plugin-eyebrow">内置能力 · 无需安装</span><h1>{plugin.name}</h1></div>
      </div>
      <p className="plugin-description">{plugin.description}</p>
      <div className="plugin-feature-list">{plugin.details.map(detail => <div key={detail}>{detail}</div>)}</div>
      <button className="plugin-open-button" type="button" onClick={() => onOpen(plugin.id)}>{plugin.action}</button>
      <div className="plugin-availability">
        <Blocks size={18} />
        <div><strong>第三方插件尚未开放</strong><p>当前不能安装或运行外部插件。上方列出的是工作区已提供的功能。</p></div>
      </div>
    </div>
  </section>;
}
