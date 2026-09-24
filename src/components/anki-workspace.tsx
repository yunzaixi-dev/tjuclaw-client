import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, BarChart3, BookOpen, Check, ChevronRight, Download, FileUp, Layers3, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';

export type AnkiCard = { id: string; front: string; back: string; tags: string };
export type AnkiWorkspaceHandle = {
  startStudy: () => void;
  openCard: (id: string) => void;
};

type AnkiMode = 'overview' | 'study' | 'browse' | 'add' | 'templates';
type CardState = 'new' | 'learning' | 'review' | 'suspended';
type CardMeta = {
  state: CardState;
  due: number;
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
  lastReviewedAt?: number;
};
type AnkiLocalState = {
  deckName: string;
  metas: Record<string, CardMeta>;
  lastStudyAt?: number;
};

const defaultMeta: CardMeta = { state: 'new', due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 };

function formatInterval(days: number) {
  if (days < 1) return '< 1 天';
  if (days < 30) return `${Math.max(1, Math.round(days))} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return `${Math.round(days / 365)} 年`;
}

function parseTags(value: string) {
  return value.split(/\s+/).map(tag => tag.trim()).filter(Boolean);
}

function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const AnkiWorkspace = forwardRef<AnkiWorkspaceHandle, { cards: AnkiCard[]; identity: string; deckName?: string; onCardsChange: (cards: AnkiCard[]) => void; onExport: () => void; onAddSampleCards?: () => Promise<void>; openCardId?: string | null; onOpenCardHandled?: () => void }>(function AnkiWorkspace({ cards, identity, deckName, onCardsChange, onExport, onAddSampleCards, openCardId, onOpenCardHandled }, ref) {
  const [mode, setMode] = useState<AnkiMode>(() => cards.length ? 'browse' : 'overview');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const [activeStudyId, setActiveStudyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [localState, setLocalState] = useState<AnkiLocalState>(() => {
    try {
      const raw = localStorage.getItem(`tjuclaw.anki.state.v2.${identity}`);
      const parsed = raw ? JSON.parse(raw) as AnkiLocalState : null;
      return parsed?.metas && typeof parsed.deckName === 'string' ? parsed : { deckName: '默认牌组', metas: {} };
    } catch {
      return { deckName: '默认牌组', metas: {} };
    }
  });
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    localStorage.setItem(`tjuclaw.anki.state.v2.${identity}`, JSON.stringify(localState));
  }, [identity, localState]);

  useEffect(() => {
    if (!openCardId) return;
    setSelectedCardId(openCardId);
    setMode('add');
    onOpenCardHandled?.();
  }, [onOpenCardHandled, openCardId]);

  const cardsWithMeta = useMemo(() => cards.map(card => ({ card, meta: localState.metas[card.id] ?? defaultMeta })), [cards, localState.metas]);
  const dueCards = useMemo(() => cardsWithMeta.filter(item => item.meta.state !== 'suspended' && item.meta.due <= now), [cardsWithMeta, now]);
  const newCount = cardsWithMeta.filter(item => item.meta.state === 'new').length;
  const learningCount = cardsWithMeta.filter(item => item.meta.state === 'learning').length;
  const reviewCount = cardsWithMeta.filter(item => item.meta.state === 'review' && item.meta.due <= now).length;
  const filteredCards = cardsWithMeta.filter(({ card }) => !search || `${card.front} ${card.back} ${card.tags}`.toLowerCase().includes(search.toLowerCase()));
  const activeStudy = cardsWithMeta.find(item => item.card.id === activeStudyId) ?? dueCards[0];
  const selectedCard = cards.find(card => card.id === selectedCardId) ?? null;
  const displayDeckName = deckName ?? localState.deckName;

  function updateCards(next: AnkiCard[]) {
    onCardsChange(next);
    if (!next.length) {
      setMode('overview');
      setSelectedCardId(null);
      setActiveStudyId(null);
    }
  }

  const beginStudy = useCallback(() => {
    const next = dueCards[0]?.card.id;
    if (!next) return;
    setActiveStudyId(next);
    setShowAnswer(false);
    setMode('study');
  }, [dueCards]);

  useImperativeHandle(ref, () => ({
    startStudy: beginStudy,
    openCard: id => {
      setSelectedCardId(id);
      setMode('add');
    },
  }), [beginStudy]);

  function answerCard(rating: 'again' | 'hard' | 'good' | 'easy') {
    if (!activeStudy) return;
    const previous = activeStudy.meta;
    const now = Date.now();
    const next: CardMeta = { ...previous, reps: previous.reps + 1, lastReviewedAt: now };
    if (rating === 'again') {
      next.state = previous.state === 'new' ? 'learning' : previous.state;
      next.interval = 0;
      next.lapses = previous.lapses + 1;
      next.due = now + 60 * 1000;
      next.ease = Math.max(1.3, previous.ease - 0.2);
    } else if (rating === 'hard') {
      next.state = previous.state === 'new' ? 'learning' : previous.state;
      next.interval = Math.max(1, previous.interval * 1.2 || 1);
      next.due = now + (next.state === 'learning' ? 10 * 60 * 1000 : next.interval * 86400000);
      next.ease = Math.max(1.3, previous.ease - 0.15);
    } else {
      const base = previous.interval || (rating === 'easy' ? 4 : 1);
      next.state = 'review';
      next.interval = rating === 'easy' ? Math.max(4, base * previous.ease * 1.3) : Math.max(1, base * previous.ease);
      next.due = now + next.interval * 86400000;
      next.ease = rating === 'easy' ? previous.ease + 0.15 : previous.ease;
    }
    const nextMetas = { ...localState.metas, [activeStudy.card.id]: next };
    setLocalState(current => ({ ...current, metas: nextMetas, lastStudyAt: now }));
    setNow(Date.now());
    const nextDue = cardsWithMeta.find(item => item.card.id !== activeStudy.card.id && item.meta.state !== 'suspended' && item.meta.due <= now);
    if (nextDue) {
      setActiveStudyId(nextDue.card.id);
      setShowAnswer(false);
    } else {
      setActiveStudyId(null);
      setShowAnswer(false);
      setMode('overview');
    }
  }

  function addCard() {
    const card: AnkiCard = { id: crypto.randomUUID(), front: '', back: '', tags: '' };
    updateCards([...cards, card]);
    setSelectedCardId(card.id);
    setMode('add');
  }

  function updateCard(id: string, patch: Partial<AnkiCard>) {
    updateCards(cards.map(card => card.id === id ? { ...card, ...patch } : card));
  }

  function deleteCard(id: string) {
    updateCards(cards.filter(card => card.id !== id));
  }

  function exportJson() {
    downloadText(`tjuclaw-${displayDeckName}.json`, JSON.stringify({ deck: displayDeckName, cards }, null, 2), 'application/json;charset=utf-8');
  }

  function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then(text => {
      const imported: AnkiCard[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const columns = line.split('\t');
        if (columns.length < 2) continue;
        imported.push({ id: crypto.randomUUID(), front: columns[0].trim(), back: columns[1].trim(), tags: columns.slice(2).join(' ').trim() });
      }
      if (imported.length) {
        updateCards([...cards, ...imported]);
        setMode('browse');
      }
    });
  }

  return <section className="anki-workspace" aria-label="Anki 记忆闪卡">
    <input ref={importRef} type="file" accept=".txt,.tsv,.csv,.json" hidden onChange={importFile} />
    <header className="anki-workspace-header">
        <div className="anki-title-block">
        <div className="anki-title-mark"><Layers3 size={18} /></div>
        <div><h1>记忆闪卡</h1><p>{displayDeckName}</p></div>
      </div>
      <div className="anki-header-actions">
        <button type="button" aria-label="导入卡片" title="导入 TSV" onClick={() => importRef.current?.click()}><Upload size={15} /></button>
        <button type="button" aria-label="导出 JSON" title="导出 JSON" onClick={exportJson} disabled={!cards.length}><Download size={15} /></button>
        <button type="button" aria-label="导出 Anki" title="导出 TSV" onClick={onExport} disabled={!cards.length}><FileUp size={15} /></button>
      </div>
    </header>
    <div className="anki-workspace-body">
      <div className="anki-content">
        {mode === 'overview' ? <div className="anki-overview">
          <div className="anki-overview-lead"><div><span className="anki-eyebrow">今天</span><h2>把记忆变成长期能力</h2><p>按照间隔复习节奏处理到期卡片，答案会保留在本地设备。</p></div><button type="button" className="anki-study-button" onClick={beginStudy} disabled={!dueCards.length}><Play size={15} /> 开始学习</button></div>
          <div className="anki-count-grid"><button type="button" onClick={beginStudy} className="anki-count-card is-new"><small>新卡</small><strong>{newCount}</strong><span>等待第一次学习</span></button><button type="button" onClick={beginStudy} className="anki-count-card is-learning"><small>学习中</small><strong>{learningCount}</strong><span>短期记忆步骤</span></button><button type="button" onClick={beginStudy} className="anki-count-card is-review"><small>待复习</small><strong>{reviewCount}</strong><span>今天需要巩固</span></button></div>
          <div className="anki-overview-columns"><section className="anki-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">牌组</span><h3>{displayDeckName}</h3></div><button type="button" onClick={() => setMode('templates')} aria-label="牌组设置"><Settings2 size={15} /></button></div><div className="anki-deck-row"><Layers3 size={18} /><div><strong>{cards.length ? displayDeckName : '等待添加卡片'}</strong><small>{cards.length ? `${dueCards.length} 张卡片今天到期` : '从添加或导入开始'}</small></div><ChevronRight size={15} /></div></section><section className="anki-panel anki-activity-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">学习状态</span><h3>最近进度</h3></div><BarChart3 size={15} /></div><div className="anki-mini-bars"><i style={{ height: `${Math.max(8, Math.min(100, newCount * 14))}%` }} /><i style={{ height: `${Math.max(8, Math.min(100, learningCount * 18))}%` }} /><i style={{ height: `${Math.max(8, Math.min(100, reviewCount * 12))}%` }} /><i style={{ height: `${Math.max(8, Math.min(100, (localState.lastStudyAt ? 62 : 12)))}%` }} /><i style={{ height: `${Math.max(8, Math.min(100, (cards.length ? 44 : 12)))}%` }} /></div><small className="anki-panel-note">{localState.lastStudyAt ? `上次学习于 ${new Date(localState.lastStudyAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '还没有学习记录'}</small></section></div>
          {!cards.length ? <div className="anki-empty"><Sparkles size={20} /><h3>还没有记忆闪卡</h3><p>导入 Anki TSV，或加载一组示例卡片开始体验。</p><button type="button" className="anki-sample-button" onClick={() => { if (onAddSampleCards) void onAddSampleCards().then(() => setMode('browse')); else { updateCards([{ id: crypto.randomUUID(), front: '什么是主动回忆？', back: '不看答案，先尝试从记忆中提取知识，再核对并修正。', tags: '学习方法 示例' }, { id: crypto.randomUUID(), front: '间隔复习的核心做法是什么？', back: '在遗忘前后分散复习，而不是集中在一天反复阅读。', tags: '学习方法 示例' }, { id: crypto.randomUUID(), front: 'Markdown 中 [[笔记名]] 通常表示什么？', back: '指向另一篇笔记的内部链接，可以用来建立知识关联。', tags: 'Markdown 示例' }, { id: crypto.randomUUID(), front: '导数 f′(x) 的几何意义是什么？', back: '函数曲线在 x 处切线的斜率。', tags: '数学 示例' }]); setMode('browse'); } }}>加载 4 张示例卡片</button></div> : null}
        </div> : null}
        {mode === 'study' ? <div className="anki-study"><div className="anki-study-top"><button type="button" onClick={() => setMode('overview')}><ArrowLeft size={15} /> 退出学习</button><span>{dueCards.length ? `${Math.max(0, cards.length - dueCards.length)} / ${cards.length}` : '今日已完成'}</span><button type="button" aria-label="暂停当前卡片"><Pause size={15} /></button></div>{activeStudy ? <div className="anki-review-stage"><div className="anki-review-meta"><span>{displayDeckName}</span><span>{parseTags(activeStudy.card.tags).map(tag => `#${tag}`).join(' ')}</span></div><button type="button" className={`anki-review-card${showAnswer ? ' is-answer' : ''}`} onClick={() => setShowAnswer(value => !value)}><span className="anki-card-side">{showAnswer ? '答案' : '问题'}</span><div dangerouslySetInnerHTML={{ __html: (showAnswer ? activeStudy.card.back : activeStudy.card.front).replace(/\n/g, '<br />') }} />{!showAnswer ? <small>点击显示答案</small> : null}</button>{showAnswer ? <div className="anki-answer-actions"><button type="button" onClick={() => answerCard('again')}><strong>重来</strong><small>1 分钟</small></button><button type="button" onClick={() => answerCard('hard')}><strong>困难</strong><small>{formatInterval(Math.max(1, activeStudy.meta.interval))}</small></button><button type="button" onClick={() => answerCard('good')}><strong>良好</strong><small>{formatInterval(Math.max(1, activeStudy.meta.interval * activeStudy.meta.ease || 1))}</small></button><button type="button" onClick={() => answerCard('easy')}><strong>简单</strong><small>{formatInterval(Math.max(4, activeStudy.meta.interval * activeStudy.meta.ease * 1.3 || 4))}</small></button></div> : null}</div> : <div className="anki-empty"><Check size={21} /><h3>今天完成了</h3><p>没有更多到期卡片。可以浏览卡片或添加新的内容。</p><button type="button" className="anki-sample-button" onClick={() => setMode('browse')}>浏览全部卡片</button></div>}</div> : null}
        {mode === 'browse' ? <div className="anki-browse"><div className="anki-page-heading"><div><span className="anki-eyebrow">浏览器</span><h2>全部卡片</h2></div><div className="anki-browse-actions"><label className="anki-inline-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索问题、答案或标签" /></label><button type="button" onClick={addCard} aria-label="添加卡片"><Plus size={16} /></button></div></div><div className="anki-browser-table"><div className="anki-browser-head"><span>问题</span><span>答案</span><span>标签</span><span>状态</span><span /></div>{filteredCards.map(({ card, meta }) => <div className="anki-browser-row" id={`anki-card-${card.id}`} key={card.id}><button type="button" className="anki-browser-cell anki-browser-front" onClick={() => { setSelectedCardId(card.id); setMode('add'); }}><strong>{card.front || '未命名卡片'}</strong><small>{card.back || '还没有答案'}</small></button><span className="anki-browser-cell">{card.back || '—'}</span><span className="anki-browser-cell anki-tags">{parseTags(card.tags).map(tag => <i key={tag}>{tag}</i>)}</span><span className={`anki-state-dot is-${meta.state}`}>{meta.state === 'new' ? '新卡' : meta.state === 'learning' ? '学习中' : meta.state === 'suspended' ? '已暂停' : '复习'}</span><button type="button" aria-label={`删除 ${card.front || '未命名卡片'}`} onClick={() => deleteCard(card.id)}><Trash2 size={14} /></button></div>)}</div>{!filteredCards.length ? <div className="anki-empty"><Search size={20} /><h3>没有匹配的卡片</h3><p>尝试搜索其他关键词，或添加一张新卡片。</p></div> : null}</div> : null}
        {mode === 'add' ? <div className="anki-add"><div className="anki-page-heading"><div><span className="anki-eyebrow">编辑器</span><h2>{selectedCard ? '编辑卡片' : '添加卡片'}</h2></div><div className="anki-add-actions">{selectedCard ? <button type="button" className="anki-danger-button" onClick={() => deleteCard(selectedCard.id)}><Trash2 size={14} /> 删除</button> : null}<button type="button" onClick={addCard}><Plus size={14} /> 新建</button></div></div><div className="anki-note-editor">{selectedCard ? <><div className="anki-editor-meta"><span>默认牌组</span><span>基础（正面 / 背面）</span><span>自动保存</span></div><label>正面<textarea value={selectedCard.front} onChange={event => updateCard(selectedCard.id, { front: event.target.value })} placeholder="问题或提示" autoFocus /></label><label>背面<textarea value={selectedCard.back} onChange={event => updateCard(selectedCard.id, { back: event.target.value })} placeholder="答案、解释或例子" /></label><label>标签<input value={selectedCard.tags} onChange={event => updateCard(selectedCard.id, { tags: event.target.value })} placeholder="使用空格分隔标签，例如：高数 期末" /></label><div className="anki-note-preview"><div><span>预览</span><button type="button" onClick={() => setMode('browse')}><X size={14} /></button></div><strong>{selectedCard.front || '正面内容'}</strong><p>{selectedCard.back || '背面内容'}</p></div></> : <div className="anki-empty"><Pencil size={20} /><h3>选择一张卡片</h3><p>从浏览器打开卡片，或创建一张新卡片。</p></div>}</div></div> : null}
        {mode === 'templates' ? <div className="anki-templates"><div className="anki-page-heading"><div><span className="anki-eyebrow">卡片类型</span><h2>基础（正面 / 背面）</h2></div><button type="button" aria-label="牌组设置"><Settings2 size={16} /></button></div><div className="anki-template-layout"><section className="anki-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">字段</span><h3>笔记字段</h3></div><button type="button" aria-label="添加字段"><Plus size={15} /></button></div><div className="anki-template-row"><span>1</span><strong>正面</strong><small>问题或提示内容</small><MoreHorizontal size={14} /></div><div className="anki-template-row"><span>2</span><strong>背面</strong><small>答案、解释或例子</small><MoreHorizontal size={14} /></div></section><section className="anki-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">模板</span><h3>卡片模板</h3></div><button type="button" aria-label="添加模板"><Plus size={15} /></button></div><div className="anki-template-preview"><span>正面模板</span><code>{'{{正面}}'}</code><hr /><span>背面模板</span><code>{'{{FrontSide}}'}<br />{'<hr id=answer>'}<br />{'{{背面}}'}</code></div></section></div><div className="anki-info-line"><BookOpen size={15} /> Anki 的字段与卡片模板分离，同一条笔记可以生成多个方向的卡片。</div></div> : null}
      </div>
    </div>
  </section>;
});
