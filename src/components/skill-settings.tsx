import { useEffect, useState } from 'react';
import { describeSkillError, listSkills, setSkill, type Skill } from '../lib/skills';
import { attempt } from '../lib/attempt';

/**
 * Skill plugins in Settings: each is a reviewed set of instructions. The
 * Agent sees the enabled ones and reads one when a task fits it.
 */
export function SkillSettings() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    listSkills(controller.signal).then(setSkills).catch(cause => { if (!controller.signal.aborted) setError(describeSkillError(cause, true)); });
    return () => controller.abort();
  }, []);

  async function toggle(skill: Skill) {
    setBusy(skill.id); setError('');
    return await attempt(async () => {
      await setSkill(skill.id, !skill.enabled);
      setSkills(current => current?.map(item => item.id === skill.id ? { ...item, enabled: !skill.enabled } : item) ?? null);
    }, async (cause) => { setError(describeSkillError(cause)); }, async () => { setBusy(''); });
  }

  return <>
    <h3>技能</h3>
    <p className="settings-about-note">技能是经过审核的做事方法。启用后，任务与某个技能相符时，Agent 会先读取它的步骤和要求再动手；没用上的技能不会影响对话。</p>
    {error ? <p className="settings-notice" role="alert">{error}</p> : null}
    {skills === null && !error ? <p className="settings-about-note" role="status">读取中…</p> : null}
    {skills ? <div className="mcp-catalog">
      {skills.map(skill => <article key={skill.id} className="mcp-card" aria-labelledby={`skill-${skill.id}`}>
        <header><strong id={`skill-${skill.id}`}>{skill.title}</strong></header>
        <p className="mcp-card-summary">{skill.summary}</p>
        <p>{skill.description}</p>
        <footer>
          <label className="mcp-switch">
            <input type="checkbox" checked={skill.enabled} disabled={busy === skill.id} onChange={() => void toggle(skill)} aria-label={`启用「${skill.title}」`} />
            <span>{skill.enabled ? '已启用' : '未启用'}</span>
          </label>
        </footer>
      </article>)}
    </div> : null}
  </>;
}
