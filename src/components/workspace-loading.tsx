import { Check } from 'lucide-react';
import { BlueprintBackdrop } from './blueprint-backdrop';
import { BrandIcon } from './brand-icon';
import './workspace-loading.css';

export type LoadStep = 'session' | 'library' | 'entries' | 'note';

const STEPS: { id: LoadStep; label: string }[] = [
  { id: 'session', label: '验证登录状态' },
  { id: 'library', label: '读取知识库' },
  { id: 'entries', label: '载入笔记与卡片' },
  { id: 'note', label: '打开上次的笔记' },
];

/**
 * Opening the workspace on the same blueprint surface as sign-in, with the
 * real loading steps. The bar also creeps within a step so a slow request
 * never looks frozen.
 */
export function WorkspaceLoading({ step }: { step: LoadStep }) {
  const current = STEPS.findIndex(item => item.id === step);
  const progress = Math.round(((current + 0.5) / STEPS.length) * 100);
  return (
    <div className="workspace-opening blueprint-surface">
      <BlueprintBackdrop />
      <section className="workspace-opening-card" role="status" aria-live="polite" aria-label={`正在打开工作区：${STEPS[current]?.label ?? ''}`}>
        <BrandIcon size={52} />
        <h1>正在打开你的知识花园</h1>
        <div className="workspace-opening-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="加载进度">
          <span key={step} style={{ '--from': `${(current / STEPS.length) * 100}%`, '--to': `${progress}%`, '--next': `${((current + 1) / STEPS.length) * 100 - 2}%` } as React.CSSProperties} />
        </div>
        <ol>
          {STEPS.map((item, index) => (
            <li key={item.id} className={index < current ? 'is-done' : index === current ? 'is-active' : ''}>
              <i aria-hidden="true">{index < current ? <Check size={12} strokeWidth={3} /> : null}</i>
              <span>{item.label}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
