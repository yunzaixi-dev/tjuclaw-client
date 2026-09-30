import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, BarChart3, BookOpen, Check, Download, FileUp, Layers3, MoreHorizontal, Pencil, Play, Plus, Search, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import './anki-workspace.css';

export type AnkiCard = { id: string; front: string; back: string; tags: string };
export type AnkiSchedule = { due: string; interval: number; ease: number; reps: number; lapses: number };
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

export const AnkiWorkspace = forwardRef<AnkiWorkspaceHandle, { cards: AnkiCard[]; identity: string; deckName?: string; schedules?: Record<string, AnkiSchedule>; lastStudyAt?: number | null; onCreateCard?: () => Promise<AnkiCard | null>; onReviewCard?: (id: string, rating: 1 | 2 | 3 | 4) => Promise<void>; onImportFile?: (file: File) => Promise<void>; onCardsChange: (cards: AnkiCard[]) => void; onExport: () => void; onAddSampleCards?: () => Promise<void>; openCardId?: string | null; onOpenCardHandled?: () => void }>(function AnkiWorkspace({ cards, identity, deckName, schedules, lastStudyAt, onCreateCard, onReviewCard, onImportFile, onCardsChange, onExport, onAddSampleCards, openCardId, onOpenCardHandled }, ref) {
  const [mode, setMode] = useState<AnkiMode>('overview');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const [activeStudyId, setActiveStudyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reviewing, setReviewing] = useState(false);
  const [importing, setImporting] = useState(false);
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

  const cardsWithMeta = useMemo(() => cards.map(card => {
    const schedule = schedules?.[card.id];
    return { card, meta: schedule ? {
      state: (schedule.reps ? 'review' : 'new') as CardState,
      due: Date.parse(schedule.due), interval: schedule.interval, ease: schedule.ease / 100,
      reps: schedule.reps, lapses: schedule.lapses,
    } : localState.metas[card.id] ?? defaultMeta };
  }), [cards, localState.metas, schedules]);
  const dueCards = useMemo(() => cardsWithMeta.filter(item => item.meta.state !== 'suspended' && item.meta.due <= now), [cardsWithMeta, now]);
  const newCount = cardsWithMeta.filter(item => item.meta.state === 'new').length;
  const learningCount = cardsWithMeta.filter(item => item.meta.state === 'learning').length;
  const reviewCount = cardsWithMeta.filter(item => item.meta.state === 'review' && item.meta.due <= now).length;
  const filteredCards = cardsWithMeta.filter(({ card }) => !search || `${card.front} ${card.back} ${card.tags}`.toLowerCase().includes(search.toLowerCase()));
  const activeStudy = cardsWithMeta.find(item => item.card.id === activeStudyId) ?? dueCards[0];
  const selectedCard = cards.find(card => card.id === selectedCardId) ?? null;
  const displayDeckName = deckName ?? localState.deckName;
  const displayedLastStudyAt = schedules ? lastStudyAt : localState.lastStudyAt;

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

  // Space or Enter reveals the answer; 1–4 rate it, as in Anki.
  const answerRef = useRef<(rating: 'again' | 'hard' | 'good' | 'easy') => void>(() => undefined);
  useEffect(() => { answerRef.current = rating => void answerCard(rating); });
  useEffect(() => {
    if (mode !== 'study') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if ((event.key === ' ' || event.key === 'Enter') && !showAnswer) { event.preventDefault(); setShowAnswer(true); return; }
      const rating = ({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' } as const)[event.key as '1' | '2' | '3' | '4'];
      if (rating && showAnswer) { event.preventDefault(); answerRef.current(rating); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, showAnswer]);

  useImperativeHandle(ref, () => ({
    startStudy: beginStudy,
    openCard: id => {
      setSelectedCardId(id);
      setMode('add');
    },
  }), [beginStudy]);

  async function answerCard(rating: 'again' | 'hard' | 'good' | 'easy') {
    if (!activeStudy || reviewing) return;
    if (onReviewCard) {
      setReviewing(true);
      try {
        await onReviewCard(activeStudy.card.id, ({ again: 1, hard: 2, good: 3, easy: 4 } as const)[rating]);
        setNow(Date.now());
        const nextDue = cardsWithMeta.find(item => item.card.id !== activeStudy.card.id && item.meta.due <= Date.now());
        if (nextDue) setActiveStudyId(nextDue.card.id);
        else { setActiveStudyId(null); setMode('overview'); }
        setShowAnswer(false);
      } catch {
        // The workspace reports the API error; keep the card visible for retry.
      } finally {
        setReviewing(false);
      }
      return;
    }
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

  async function addCard() {
    const card = onCreateCard ? await onCreateCard() : { id: crypto.randomUUID(), front: '', back: '', tags: '' };
    if (!card) return;
    if (!onCreateCard) updateCards([...cards, card]);
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
    if (!file || importing) return;
    if (onImportFile) {
      setImporting(true);
      void onImportFile(file).then(() => setMode('browse')).catch(() => {
        // The parent shows the service error and retains the current deck.
      }).finally(() => setImporting(false));
      return;
    }
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
    <input ref={importRef} type="file" accept=".txt,.tsv" hidden onChange={importFile} />
    <div className="anki-workspace-body">
      <div className="anki-content">
        <header className="anki-workspace-header">
          <div className="anki-title-block">
            <p className="anki-crumb"><Layers3 size={14} />记忆闪卡</p>
            <h1>{displayDeckName}</h1>
          </div>
          <div className="anki-header-actions">
            <button type="button" aria-label="导入卡片" title="导入 TSV" disabled={importing} onClick={() => importRef.current?.click()}><Upload size={15} /></button>
            <button type="button" aria-label="导出 JSON" title="导出 JSON" onClick={exportJson} disabled={!cards.length}><Download size={15} /></button>
            <button type="button" aria-label="导出 Anki" title="导出 TSV" onClick={onExport} disabled={!cards.length}><FileUp size={15} /></button>
          </div>
        </header>
        {mode === 'overview' ? <div className="anki-overview">
          <section className="anki-hero">
            <div className="anki-hero-copy">
              <span className="anki-eyebrow">今天 · {new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</span>
              <h2>{dueCards.length ? <><em>{dueCards.length}</em> 张卡片等你复习</> : cards.length ? '今天的复习都完成了' : '做第一组记忆闪卡'}</h2>
              <p className="anki-panel-note">{displayedLastStudyAt ? `上次学习于 ${new Date(displayedLastStudyAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '还没有学习记录'}</p>
              <div className="anki-overview-actions">
                <button type="button" className="anki-study-button" onClick={beginStudy} disabled={!dueCards.length}><Play size={15} /> 开始学习</button>
                <button type="button" className="anki-sample-button" onClick={() => setMode('browse')}>浏览卡片</button>
              </div>
            </div>
            <div className="anki-hero-ring" role="img" aria-label={cards.length ? `今天已完成 ${cards.length - dueCards.length} / ${cards.length}` : '还没有卡片'}>
              <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" className="anki-ring-track" /><circle cx="60" cy="60" r="50" className="anki-ring-value" pathLength={100} strokeDasharray={`${cards.length ? Math.round(((cards.length - dueCards.length) / cards.length) * 100) : 0} 100`} /></svg>
              <span><strong>{cards.length ? Math.round(((cards.length - dueCards.length) / cards.length) * 100) : 0}%</strong><small>今日进度</small></span>
            </div>
          </section>
          <div className="anki-count-grid"><button type="button" onClick={beginStudy} className={`anki-count-card is-new${newCount ? '' : ' is-empty'}`}><small>新卡</small><strong>{newCount}</strong><span>等待第一次学习</span></button><button type="button" onClick={beginStudy} className={`anki-count-card is-learning${learningCount ? '' : ' is-empty'}`}><small>学习中</small><strong>{learningCount}</strong><span>短期记忆步骤</span></button><button type="button" onClick={beginStudy} className={`anki-count-card is-review${reviewCount ? '' : ' is-empty'}`}><small>待复习</small><strong>{reviewCount}</strong><span>今天需要巩固</span></button></div>
          {!cards.length ? <div className="anki-empty"><Sparkles size={20} /><h3>还没有记忆闪卡</h3><p>导入 Anki TSV，或加载一组示例卡片开始体验。</p><button type="button" className="anki-sample-button" onClick={() => { if (onAddSampleCards) void onAddSampleCards().then(() => setMode('browse')); else { updateCards([{ id: crypto.randomUUID(), front: '什么是主动回忆？', back: '不看答案，先尝试从记忆中提取知识，再核对并修正。', tags: '学习方法 示例' }, { id: crypto.randomUUID(), front: '间隔复习的核心做法是什么？', back: '在遗忘前后分散复习，而不是集中在一天反复阅读。', tags: '学习方法 示例' }, { id: crypto.randomUUID(), front: 'Markdown 中 [[笔记名]] 通常表示什么？', back: '指向另一篇笔记的内部链接，可以用来建立知识关联。', tags: 'Markdown 示例' }, { id: crypto.randomUUID(), front: '导数 f′(x) 的几何意义是什么？', back: '函数曲线在 x 处切线的斜率。', tags: '数学 示例' }]); setMode('browse'); } }}>加载 4 张示例卡片</button></div> : null}
        </div> : null}
        {mode === 'study' ? <div className="anki-study">
          <div className="anki-study-top"><button type="button" onClick={() => setMode('overview')}><ArrowLeft size={15} /> 退出学习</button><div className="anki-study-progress" role="progressbar" aria-label="今日进度" aria-valuemin={0} aria-valuemax={cards.length} aria-valuenow={Math.max(0, cards.length - dueCards.length)}><i style={{ width: `${cards.length ? ((cards.length - dueCards.length) / cards.length) * 100 : 100}%` }} /></div><span>{dueCards.length ? `还剩 ${dueCards.length} 张` : '今日已完成'}</span></div>
          {activeStudy ? <div className="anki-review-stage">
            {activeStudy.card.tags.trim() ? <div className="anki-review-meta"><span>{parseTags(activeStudy.card.tags).map(tag => `#${tag}`).join(' ')}</span></div> : null}
            <button type="button" className={`anki-review-card${showAnswer ? ' is-answer' : ''}`} onClick={() => setShowAnswer(value => !value)}>
              <span className="anki-card-side">{showAnswer ? '答案' : '问题'}</span>
              <div style={{ whiteSpace: 'pre-wrap' }}>{showAnswer ? activeStudy.card.back : activeStudy.card.front}</div>
              {!showAnswer ? <small>点击或按空格显示答案</small> : null}
            </button>
            {showAnswer ? <div className="anki-answer-actions">
              <button type="button" className="is-again" disabled={reviewing} onClick={() => void answerCard('again')}><kbd>1</kbd><strong>重来</strong><small>1 分钟</small></button>
              <button type="button" className="is-hard" disabled={reviewing} onClick={() => void answerCard('hard')}><kbd>2</kbd><strong>困难</strong><small>{onReviewCard && !activeStudy.meta.reps ? '10 分钟' : formatInterval(Math.max(1, activeStudy.meta.interval))}</small></button>
              <button type="button" className="is-good" disabled={reviewing} onClick={() => void answerCard('good')}><kbd>3</kbd><strong>良好</strong><small>{formatInterval(onReviewCard ? Math.max(1, activeStudy.meta.interval * 2) : Math.max(1, activeStudy.meta.interval * activeStudy.meta.ease || 1))}</small></button>
              <button type="button" className="is-easy" disabled={reviewing} onClick={() => void answerCard('easy')}><kbd>4</kbd><strong>简单</strong><small>{formatInterval(onReviewCard ? Math.max(4, activeStudy.meta.interval * 3) : Math.max(4, activeStudy.meta.interval * activeStudy.meta.ease * 1.3 || 4))}</small></button>
            </div> : null}
          </div> : <div className="anki-empty"><Check size={21} /><h3>今天完成了</h3><p>没有更多到期卡片。可以浏览卡片或添加新的内容。</p><button type="button" className="anki-sample-button" onClick={() => setMode('browse')}>浏览全部卡片</button></div>}
        </div> : null}
        {mode === 'browse' ? <div className="anki-browse"><div className="anki-page-heading"><div><span className="anki-eyebrow">浏览器</span><h2>全部卡片</h2></div><div className="anki-browse-actions"><button type="button" onClick={() => setMode('overview')} aria-label="查看学习概览"><BarChart3 size={16} /></button><label className="anki-inline-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索问题、答案或标签" /></label><button type="button" onClick={addCard} aria-label="添加卡片"><Plus size={16} /></button></div></div><div className="anki-browser-table"><div className="anki-browser-head"><span>问题</span><span>答案</span><span>标签</span><span>状态</span><span /></div>{filteredCards.map(({ card, meta }) => <div className="anki-browser-row" id={`anki-card-${card.id}`} key={card.id}><button type="button" className="anki-browser-cell anki-browser-front" onClick={() => { setSelectedCardId(card.id); setMode('add'); }}><strong>{card.front || '未命名卡片'}</strong><small>{card.back || '还没有答案'}</small></button><span className="anki-browser-cell">{card.back || '—'}</span><span className="anki-browser-cell anki-tags">{parseTags(card.tags).map(tag => <i key={tag}>{tag}</i>)}</span><span className={`anki-state-dot is-${meta.state}`}>{meta.state === 'new' ? '新卡' : meta.state === 'learning' ? '学习中' : meta.state === 'suspended' ? '已暂停' : '复习'}</span><button type="button" aria-label={`删除 ${card.front || '未命名卡片'}`} onClick={() => deleteCard(card.id)}><Trash2 size={14} /></button></div>)}</div>{!filteredCards.length ? <div className="anki-empty"><Search size={20} /><h3>没有匹配的卡片</h3><p>尝试搜索其他关键词，或添加一张新卡片。</p></div> : null}</div> : null}
        {mode === 'add' ? <div className="anki-add"><div className="anki-page-heading"><div><span className="anki-eyebrow">编辑器</span><h2>{selectedCard ? '编辑卡片' : '添加卡片'}</h2></div><div className="anki-add-actions">{selectedCard ? <button type="button" className="anki-danger-button" onClick={() => deleteCard(selectedCard.id)}><Trash2 size={14} /> 删除</button> : null}<button type="button" onClick={addCard}><Plus size={14} /> 新建</button></div></div><div className="anki-note-editor">{selectedCard ? <><div className="anki-editor-meta"><span>默认牌组</span><span>基础（正面 / 背面）</span><span>自动保存</span></div><label>正面<textarea value={selectedCard.front} onChange={event => updateCard(selectedCard.id, { front: event.target.value })} placeholder="问题或提示" autoFocus /></label><label>背面<textarea value={selectedCard.back} onChange={event => updateCard(selectedCard.id, { back: event.target.value })} placeholder="答案、解释或例子" /></label><label>标签<input value={selectedCard.tags} onChange={event => updateCard(selectedCard.id, { tags: event.target.value })} placeholder="使用空格分隔标签，例如：高数 期末" /></label><div className="anki-note-preview"><div><span>预览</span><button type="button" onClick={() => setMode('browse')}><X size={14} /></button></div><strong>{selectedCard.front || '正面内容'}</strong><p>{selectedCard.back || '背面内容'}</p></div></> : <div className="anki-empty"><Pencil size={20} /><h3>选择一张卡片</h3><p>从浏览器打开卡片，或创建一张新卡片。</p></div>}</div></div> : null}
        {mode === 'templates' ? <div className="anki-templates"><div className="anki-page-heading"><div><span className="anki-eyebrow">卡片类型</span><h2>基础（正面 / 背面）</h2></div><button type="button" aria-label="牌组设置"><Settings2 size={16} /></button></div><div className="anki-template-layout"><section className="anki-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">字段</span><h3>笔记字段</h3></div><button type="button" aria-label="添加字段"><Plus size={15} /></button></div><div className="anki-template-row"><span>1</span><strong>正面</strong><small>问题或提示内容</small><MoreHorizontal size={14} /></div><div className="anki-template-row"><span>2</span><strong>背面</strong><small>答案、解释或例子</small><MoreHorizontal size={14} /></div></section><section className="anki-panel"><div className="anki-panel-heading"><div><span className="anki-eyebrow">模板</span><h3>卡片模板</h3></div><button type="button" aria-label="添加模板"><Plus size={15} /></button></div><div className="anki-template-preview"><span>正面模板</span><code>{'{{正面}}'}</code><hr /><span>背面模板</span><code>{'{{FrontSide}}'}<br />{'<hr id=answer>'}<br />{'{{背面}}'}</code></div></section></div><div className="anki-info-line"><BookOpen size={15} /> Anki 的字段与卡片模板分离，同一条笔记可以生成多个方向的卡片。</div></div> : null}
      </div>
    </div>
  </section>;
});
