import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Blocks, BookOpen, Bot, ChevronRight, CircleHelp, KeyRound, LibraryBig, LogOut, Monitor, Moon, Palette, Plug, Search, Settings2, SquareStack, Sun, UserRound, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { AgentRuntimeSetting } from './agent-runtime-setting';
import { CampusAccounts } from './campus-accounts';
import { McpSettings } from './mcp-settings';
import { SkillSettings } from './skill-settings';
import { builtInPlugins, type BuiltInPluginId } from './workspace-plugins';
import { setAppearance, useAppearance, type Accent, type Mode, type PageFont } from '../lib/appearance';
import { applyUpdate, checkForUpdate, subscribeUpdate, updateWaiting } from '../lib/pwa';
import { versionLabel } from '../lib/version';
import { chooseProductModel, clearModel, describeLibraryError, getModel, formatQuotaReset, formatQuotaUse, modelDisplayName, putModel, quotaWindowName, type ModelStatus } from '../lib/library';

export type SettingsSection = 'appearance' | 'editor' | 'library' | 'flashcards' | 'model' | 'campus' | 'plugins' | 'mcp' | 'account' | 'about';

const sections = [
  { id: 'appearance', label: '外观', icon: Palette, keywords: '配色 主题 强调色 深色 浅色 背景 动画 生命游戏' },
  { id: 'editor', label: '编辑器', icon: BookOpen, keywords: 'Markdown 阅读 编辑 即时预览' },
  { id: 'library', label: '资料夹与链接', icon: LibraryBig, keywords: '知识库 笔记 文件夹 目录' },
  { id: 'flashcards', label: '记忆闪卡', icon: SquareStack, keywords: 'Anki 导出 TSV' },
  { id: 'model', label: '模型', icon: Bot, keywords: '模型 API 自定义 OpenAI 密钥 蓝色大肥鱼 太阳' },
  { id: 'campus', label: '校园账号', icon: KeyRound, keywords: '微北洋 办公网 绑定 课表 GPA 入校码' },
  { id: 'plugins', label: '插件', icon: Blocks, keywords: '插件 知识图谱 编辑器 闪卡 内置 技能 实验报告 参考文献 复习 文献 调试 英文写作' },
  { id: 'mcp', label: 'MCP 服务', icon: Plug, keywords: 'MCP 工具 服务 扩展 市场 GitHub 高德 搜索 DeepWiki Context7' },
  { id: 'account', label: '账户', icon: UserRound, keywords: '邮箱 额度 模型调用 退出登录' },
  { id: 'about', label: '关于', icon: CircleHelp, keywords: '版本 帮助' },
] as const;

const descriptions: Record<SettingsSection, string> = {
  appearance: '调整工作区的色彩与显示方式。',
  editor: '专注书写，让 Markdown 保持可编辑。',
  library: '当前知识库中的内容概况。',
  flashcards: '管理记忆卡片与 Anki 格式导出。',
  model: 'Agent 对话使用的模型服务。',
  campus: '校园小工具使用的微北洋与办公网账号，各自独立绑定。',
  plugins: '工作区内置的能力，以及可以按需启用的 Agent 技能。',
  mcp: '为 Agent 接入外部服务的工具。',
  account: '当前登录状态与账户操作。',
  about: '关于此工作区。',
};

/** Web: asks for a newer build on demand. The desktop app updates through its own notice. */
function UpdateCheck() {
  const waiting = useSyncExternalStore(subscribeUpdate, updateWaiting, () => false);
  const [state, setState] = useState<'idle' | 'checking' | 'current' | 'unavailable'>('idle');
  if (isTauri()) return null;
  const check = async () => {
    setState('checking');
    const result = await checkForUpdate();
    setState(result === 'ready' ? 'idle' : result);
  };
  const description = waiting ? '新版本已下载，刷新后生效。' : state === 'current' ? '已是最新版本。'
    : state === 'unavailable' ? '当前环境无法检查更新，刷新页面即可获取最新版本。' : '网页版会在后台自动检查；也可以现在检查。';
  return <SettingRow title="更新" description={description}>
    {waiting
      ? <button type="button" className="settings-action-button" onClick={applyUpdate}>刷新以更新</button>
      : <button type="button" className="settings-action-button" disabled={state === 'checking'} onClick={() => void check()}>{state === 'checking' ? '正在检查…' : '检查更新'}</button>}
  </SettingRow>;
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-entry"><div className="settings-entry-copy"><strong>{title}</strong>{description ? <span>{description}</span> : null}</div><div className="settings-entry-action">{children}</div></div>;
}

function SettingChoices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; Icon?: typeof Monitor }[]; onChange: (value: T) => void }) {
  return <div className="settings-segments" role="group" aria-label={label}>{options.map(({ value: option, label: name, Icon }) => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>{Icon ? <Icon size={15} /> : null}{name}</button>)}</div>;
}

// System workspace connections need the tjuclaw CLI, which users cannot get
// yet: it is not published and only desktop builds after the next release
// bundle it. Until then Settings does not lead there; /workspace/connections
// itself stays reachable for acceptance.
const SYSTEM_WORKSPACES_LISTED = false;

export function WorkspaceSettings({
  open, onOpenChange, section, onSectionChange, libraryName, fileCount, noteCount, folderCount, cardCount, email, editorMode, onEditorModeChange,
  onShowNotes, onShowCards, onExportCards, legacyAnkiBackupAvailable, onExportLegacyAnkiBackup, onLogout, identity, onOpenPlugin,
}: {
  identity: string;
  onOpenPlugin: (id: BuiltInPluginId) => void;
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
  legacyAnkiBackupAvailable: boolean;
  onExportLegacyAnkiBackup: () => void;
  onLogout: () => void;
}) {
  const appearance = useAppearance();
  const [search, setSearch] = useState('');
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [modelError, setModelError] = useState('');
  const [modelForm, setModelForm] = useState({ baseUrl: '', apiKey: '', name: '' });
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNotice, setModelNotice] = useState('');
  const [modelFormError, setModelFormError] = useState('');
  const matches = sections.filter(item => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const active = search && !matches.some(item => item.id === section) ? matches[0]?.id ?? section : section;
  const heading = sections.find(item => item.id === active)?.label ?? '设置';

  useEffect(() => {
    if (!open || (active !== 'account' && active !== 'model')) return;
    const controller = new AbortController();
    getModel(controller.signal).then(status => {
      setModelStatus(status);
      setModelError('');
    }).catch(error => {
      if (controller.signal.aborted) return;
      setModelStatus(null);
      setModelError(describeLibraryError(error));
    });
    return () => controller.abort();
  }, [open, active]);

  function resetModelForm() {
    setModelForm({ baseUrl: '', apiKey: '', name: '' });
    setModelNotice('');
    setModelFormError('');
  }

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    if (modelBusy) return;
    setModelBusy(true); setModelNotice(''); setModelFormError('');
    try {
      const name = modelForm.name.trim();
      const status = await putModel({ base_url: modelForm.baseUrl.trim(), api_key: modelForm.apiKey.trim(), ...(name ? { model: name } : {}) });
      setModelStatus(status);
      setModelForm(form => ({ ...form, apiKey: '' }));
      setModelNotice('已保存，后续对话将使用你的模型。');
    } catch (error) {
      setModelFormError(describeLibraryError(error));
    } finally {
      setModelBusy(false);
    }
  }

  async function pickProductModel(name: string) {
    if (modelBusy || (modelStatus?.source === 'product' && modelStatus.name === name)) return;
    setModelBusy(true); setModelNotice(''); setModelFormError('');
    try {
      // The title and pressed state update in place; no separate notice.
      setModelStatus(await chooseProductModel(name));
    } catch (error) {
      setModelFormError(describeLibraryError(error));
    } finally {
      setModelBusy(false);
    }
  }

  async function switchToProductModel() {
    if (modelBusy) return;
    setModelBusy(true); setModelNotice(''); setModelFormError('');
    try {
      await clearModel();
      setModelStatus(await getModel());
      setModelNotice('已改回 TJUClaw 提供的模型。');
    } catch (error) {
      setModelFormError(describeLibraryError(error));
    } finally {
      setModelBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={nextOpen => {
    if (!nextOpen) {
      setModelStatus(null);
      setModelError('');
      resetModelForm();
    }
    onOpenChange(nextOpen);
  }}>
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
              <SettingRow title="页面字体" description="笔记正文与标题使用的字体。"><SettingChoices<PageFont> label="页面字体" value={appearance.font} onChange={font => setAppearance({ font })} options={[{ value: 'sans', label: '默认' }, { value: 'serif', label: '文楷' }, { value: 'mono', label: '等宽' }]} /></SettingRow>
              <SettingRow title="会话背景动画" description="在会话页的背景上播放康威生命游戏。默认关闭。"><SettingChoices<'off' | 'on'> label="会话背景动画" value={appearance.life ? 'on' : 'off'} onChange={value => setAppearance({ life: value === 'on' })} options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]} /></SettingRow>
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
              <SettingRow title="文件夹" description="知识库中的目录组织。"><span className="settings-value">{folderCount}</span></SettingRow>
            </> : null}
            {active === 'flashcards' ? <>
              <h3>卡片</h3>
              <SettingRow title="记忆闪卡" description="卡片包含正面、背面与标签。"><button type="button" className="settings-action-button" onClick={onShowCards}>查看 {cardCount} 张卡片 <ChevronRight size={14} /></button></SettingRow>
              <SettingRow title="导出到 Anki" description="导出制表符分隔的文本，在 Anki 中导入。"><button type="button" className="settings-action-button" onClick={onExportCards} disabled={!cardCount}>导出 TSV</button></SettingRow>
              {legacyAnkiBackupAvailable ? <SettingRow title="旧版浏览器数据" description="旧版卡片没有账号归属，不会自动合并到当前账号。请确认数据属于你后自行备份。"><button type="button" className="settings-action-button" onClick={onExportLegacyAnkiBackup}>下载原始备份</button></SettingRow> : null}
            </> : null}
            {active === 'model' ? <>
              <AgentRuntimeSetting />
              <h3>当前模型</h3>
              <SettingRow
                title={modelStatus ? modelDisplayName(modelStatus) : modelError ? '暂不可用' : '读取中…'}
                description={modelStatus?.source === 'custom' ? '你自己的模型服务，使用你自己的额度。' : modelStatus?.source === 'product' ? '由 TJUClaw 提供，按 5 小时和 7 天滚动计算额度。' : modelStatus ? '还没有可用的模型，请在下方配置。' : undefined}
              >
                {modelStatus?.source === 'custom'
                  ? <button type="button" className="settings-action-button" disabled={modelBusy} onClick={() => void switchToProductModel()}>改回 TJUClaw 模型</button>
                  : <span className="settings-badge">{modelStatus?.source === 'product' ? 'TJUClaw' : '—'}</span>}
              </SettingRow>
              {modelStatus?.choices && modelStatus.choices.length > 1 ? (
                <SettingRow title="TJUClaw 模型" description="在 TJUClaw 提供的模型之间切换，共用每日调用额度。">
                  <SettingChoices<string>
                    label="TJUClaw 模型"
                    value={modelStatus.source === 'product' ? modelStatus.name ?? '' : ''}
                    onChange={name => void pickProductModel(name)}
                    options={modelStatus.choices.map(name => ({ value: name, label: modelDisplayName({ source: 'product', name }) }))}
                  />
                </SettingRow>
              ) : null}
              {modelError ? <p className="settings-notice" role="alert">{modelError}</p> : null}
              <h3>使用自己的模型</h3>
              <form className="settings-model-form" onSubmit={event => void saveModel(event)}>
                <label>
                  <span>API 地址</span>
                  <input type="url" inputMode="url" required autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={modelForm.baseUrl} disabled={modelBusy} onChange={event => { setModelForm(form => ({ ...form, baseUrl: event.target.value })); setModelFormError(''); }} />
                </label>
                <label>
                  <span>API Key</span>
                  <input type="password" required autoComplete="off" spellCheck={false} maxLength={512} placeholder={modelStatus?.source === 'custom' ? '重新填写以更新' : 'sk-…'} value={modelForm.apiKey} disabled={modelBusy} onChange={event => { setModelForm(form => ({ ...form, apiKey: event.target.value })); setModelFormError(''); }} />
                </label>
                <label>
                  <span>模型名<em>可选</em></span>
                  <input type="text" autoComplete="off" spellCheck={false} maxLength={80} placeholder="例如 deepseek-chat" value={modelForm.name} disabled={modelBusy} onChange={event => { setModelForm(form => ({ ...form, name: event.target.value })); setModelFormError(''); }} />
                </label>
                <p className="settings-model-hint">需要公网 HTTPS、兼容 OpenAI Chat Completions 的地址。密钥保存在服务器上，只用于转发你的对话，不会写入笔记；使用自己的模型不占用 AI 额度。</p>
                {modelFormError ? <p className="settings-notice" role="alert">{modelFormError}</p> : modelNotice ? <p className="settings-model-saved">{modelNotice}</p> : null}
                <div className="settings-model-actions">
                  <button type="submit" className="settings-action-button is-primary" disabled={modelBusy || !modelForm.baseUrl.trim() || !modelForm.apiKey.trim()}>{modelBusy ? '正在保存…' : '保存并使用'}</button>
                </div>
              </form>
            </> : null}
            {active === 'campus' ? <CampusAccounts identity={identity} /> : null}
            {active === 'mcp' ? <McpSettings /> : null}
            {active === 'plugins' ? <>
              <h3>内置插件</h3>
              {builtInPlugins.map(plugin => <SettingRow key={plugin.id} title={plugin.name} description={plugin.description}><button type="button" className="settings-action-button" onClick={() => onOpenPlugin(plugin.id)}>{plugin.action} <ChevronRight size={14} /></button></SettingRow>)}
              <SkillSettings />
            </> : null}
            {active === 'account' ? <>
              <h3>当前会话</h3>
              <SettingRow title="登录邮箱"><span className="settings-value settings-email">{email}</span></SettingRow>
{SYSTEM_WORKSPACES_LISTED ? <SettingRow title="系统工作空间连接" description="管理同账号的完整系统环境与远程能力，不是当前知识资料库。"><a className="settings-action-button" style={{ minHeight: 44 }} href="/workspace/connections">管理系统连接 <ChevronRight size={14} aria-hidden="true" /></a></SettingRow> : null}
              {!modelError && modelStatus?.windows?.length ? modelStatus.windows.map(window => <SettingRow key={window.id} title={`${quotaWindowName(window.id)}内 AI 额度`} description={window.unit === 'tokens'
                ? (window.used && window.resets_at ? `滚动统计，按模型实际消耗的 token 计，不同模型倍率不同；最早的用量将于${formatQuotaReset(window.resets_at)}恢复。` : '滚动统计，按模型实际消耗的 token 计，不同模型倍率不同。使用自己的模型不占用额度。')
                : (window.used && window.resets_at ? `滚动统计，每轮对话计一次；最早的一次将于${formatQuotaReset(window.resets_at)}恢复。` : '滚动统计，每轮对话计一次。使用自己的模型不占用额度。')}><span className="settings-value" role="status">{formatQuotaUse(window)}</span></SettingRow>)
                : <SettingRow title="AI 额度" description="使用自己的模型不占用额度。"><span className="settings-value" role="status">{modelError ? '暂不可用' : modelStatus ? `${modelStatus.quota.used} / ${modelStatus.quota.limit}` : '读取中…'}</span></SettingRow>}
              {modelError ? <p className="settings-notice" role="alert">{modelError}</p> : null}
              <SettingRow title="退出登录" description="退出此设备上的当前会话。"><button type="button" className="settings-action-button is-danger" onClick={onLogout}><LogOut size={15} /> 退出登录</button></SettingRow>
            </> : null}
            {active === 'about' ? <>
              <h3>版本</h3>
              <SettingRow title="当前版本" description="版本号后的短码是这次构建对应的提交。"><span className="settings-value">{versionLabel}</span></SettingRow>
              <UpdateCheck />
              <h3>工作区</h3>
              <SettingRow title="笔记工作区" description="笔记、文件夹与记忆闪卡保存在服务端；旧版浏览器卡片不会自动合并。"><span className="settings-value">Web</span></SettingRow>
              <p className="settings-about-note">记忆闪卡支持 TSV 导出；Anki 模板、调度与媒体解释器尚未接入。Agent 能力以当前服务端实际可用范围为准；可以在“插件”中启用技能、在“MCP 服务”中接入外部工具。</p>
            </> : null}
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
