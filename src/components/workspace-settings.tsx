import { useState, type ReactNode } from 'react';
import { BookOpen, Brain, ChevronRight, CircleHelp, LibraryBig, LogOut, Monitor, Moon, Palette, Search, Settings2, Sun, UserRound, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { setAppearance, useAppearance, type Accent, type Mode } from '../lib/appearance';

export type SettingsSection = 'appearance' | 'editor' | 'library' | 'flashcards' | 'account' | 'about';

const sections = [
  { id: 'appearance', label: '外观', icon: Palette, keywords: '配色 主题 强调色 深色 浅色' },
  { id: 'editor', label: '编辑器', icon: BookOpen, keywords: 'Markdown 阅读 编辑 即时预览' },
  { id: 'library', label: '资料夹与链接', icon: LibraryBig, keywords: '知识库 笔记 文件夹 目录' },
  { id: 'flashcards', label: '记忆闪卡', icon: Brain, keywords: 'Anki 导出 TSV' },
  { id: 'account', label: '账户', icon: UserRound, keywords: '邮箱 退出登录' },
  { id: 'about', label: '关于', icon: CircleHelp, keywords: '版本 帮助' },
] as const;

const descriptions: Record<SettingsSection, string> = {
  appearance: '调整工作区的色彩与显示方式。',
  editor: '专注书写，让 Markdown 保持可编辑。',
  library: '当前知识库中的内容概况。',
  flashcards: '管理记忆卡片与 Anki 格式导出。',
  account: '当前登录状态与账户操作。',
  about: '关于此工作区。',
};

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-entry"><div className="settings-entry-copy"><strong>{title}</strong>{description ? <span>{description}</span> : null}</div><div className="settings-entry-action">{children}</div></div>;
}

function SettingChoices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; Icon?: typeof Monitor }[]; onChange: (value: T) => void }) {
  return <div className="settings-segments" role="group" aria-label={label}>{options.map(({ value: option, label: name, Icon }) => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>{Icon ? <Icon size={15} /> : null}{name}</button>)}</div>;
}

export function WorkspaceSettings({
  open, onOpenChange, section, onSectionChange, libraryName, fileCount, noteCount, folderCount, cardCount, email, editorMode, onEditorModeChange,
  onShowNotes, onShowCards, onExportCards, onLogout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  libraryName: string;
  fileCount: number;
  noteCount: number;
  folderCount: number;
  cardCount: number;
  email: string;
  editorMode: 'edit' | 'preview';
  onEditorModeChange: (mode: 'edit' | 'preview') => void;
  onShowNotes: () => void;
  onShowCards: () => void;
  onExportCards: () => void;
  onLogout: () => void;
}) {
  const appearance = useAppearance();
  const [search, setSearch] = useState('');
  const matches = sections.filter(item => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const active = search && !matches.some(item => item.id === section) ? matches[0]?.id ?? section : section;
  const heading = sections.find(item => item.id === active)?.label ?? '设置';

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="workspace-settings">
      <div className="settings-shell">
        <aside className="settings-navigation">
          <div className="settings-navigation-title"><Settings2 size={17} /><span>设置</span></div>
          <label className="settings-search"><Search size={16} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索设置…" aria-label="搜索设置" /></label>
          <nav className="settings-sections" aria-label="设置分类">
            {matches.length ? matches.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={active === id ? 'is-active' : ''} aria-current={active === id ? 'page' : undefined} onClick={() => { onSectionChange(id); setSearch(''); }}><Icon size={17} /><span>{label}</span></button>) : <span className="settings-empty-search">没有匹配的设置</span>}
          </nav>
          <span className="settings-navigation-foot">{libraryName}</span>
        </aside>
        <div className="settings-content">
          <header className="settings-content-header"><div><DialogTitle>{heading}</DialogTitle><DialogDescription>{descriptions[active]}</DialogDescription></div><DialogClose asChild><button className="settings-close" type="button" aria-label="关闭设置"><X size={18} /></button></DialogClose></header>
          <div className="settings-content-body">
            {active === 'appearance' ? <>
              <h3>界面</h3>
              <SettingRow title="配色模式" description="跟随系统，或固定为浅色、深色。"><SettingChoices<Mode> label="配色模式" value={appearance.mode} onChange={mode => setAppearance({ mode })} options={[{ value: 'system', label: '系统', Icon: Monitor }, { value: 'light', label: '浅色', Icon: Sun }, { value: 'dark', label: '深色', Icon: Moon }]} /></SettingRow>
              <SettingRow title="强调色" description="仅用于当前选中项和操作焦点。"><SettingChoices<Accent> label="强调色" value={appearance.accent} onChange={accent => setAppearance({ accent })} options={[{ value: 'mono', label: '单色' }, { value: 'blue', label: '蓝色' }]} /></SettingRow>
              {!appearance.canPersist ? <p className="settings-notice" role="status">浏览器阻止保存外观偏好，本次会话内仍可调整。</p> : null}
            </> : null}
            {active === 'editor' ? <>
              <h3>笔记</h3>
              <SettingRow title="当前视图" description="切换当前笔记的编辑和阅读模式。"><SettingChoices<'edit' | 'preview'> label="笔记视图" value={editorMode} onChange={onEditorModeChange} options={[{ value: 'edit', label: '即时预览' }, { value: 'preview', label: '阅读' }]} /></SettingRow>
              <SettingRow title="Markdown 源文件" description="编辑内容保留 Markdown 标记，并自动保存。"><span className="settings-value">CodeMirror 6</span></SettingRow>
            </> : null}
            {active === 'library' ? <>
              <h3>当前知识库</h3>
              <SettingRow title={libraryName} description="工作区中的笔记与目录。"><button type="button" className="settings-action-button" onClick={onShowNotes}>查看笔记 <ChevronRight size={14} /></button></SettingRow>
              <SettingRow title="文件" description="Markdown 笔记与知识库附件。"><span className="settings-value">{fileCount}</span></SettingRow>
              <SettingRow title="笔记" description="保存在知识库中的 Markdown 文档。"><span className="settings-value">{noteCount}</span></SettingRow>
              <SettingRow title="文件夹" description="当前浏览器中的目录组织。"><span className="settings-value">{folderCount}</span></SettingRow>
            </> : null}
            {active === 'flashcards' ? <>
              <h3>卡片</h3>
              <SettingRow title="记忆闪卡" description="卡片包含正面、背面与标签。"><button type="button" className="settings-action-button" onClick={onShowCards}>查看 {cardCount} 张卡片 <ChevronRight size={14} /></button></SettingRow>
              <SettingRow title="导出到 Anki" description="导出制表符分隔的文本，在 Anki 中导入。"><button type="button" className="settings-action-button" onClick={onExportCards} disabled={!cardCount}>导出 TSV</button></SettingRow>
            </> : null}
            {active === 'account' ? <>
              <h3>当前会话</h3>
              <SettingRow title="登录邮箱"><span className="settings-value settings-email">{email}</span></SettingRow>
              <SettingRow title="退出登录" description="退出此设备上的当前会话。"><button type="button" className="settings-action-button is-danger" onClick={onLogout}><LogOut size={15} /> 退出登录</button></SettingRow>
            </> : null}
            {active === 'about' ? <>
              <h3>工作区</h3>
              <SettingRow title="笔记工作区" description="笔记与 Agent 连接服务端；文件夹和记忆闪卡保存在当前浏览器。"><span className="settings-value">Web</span></SettingRow>
              <p className="settings-about-note">记忆闪卡支持 TSV 导出；Anki 模板、调度与媒体解释器尚未接入。Agent 能力以当前服务端实际可用范围为准；第三方插件尚未开放。</p>
            </> : null}
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
