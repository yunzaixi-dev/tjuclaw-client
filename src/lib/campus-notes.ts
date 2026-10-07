import { useSyncExternalStore } from 'react';
import { campusToolList } from '../components/campus-tool-list';

export type CampusNoteId = 'schedule' | 'entry';
export const campusNotes = campusToolList.filter((tool): tool is typeof tool & { id: CampusNoteId } =>
  tool.id === 'schedule' || tool.id === 'entry');
export const isCampusNoteId = (id: string): id is CampusNoteId => id === 'schedule' || id === 'entry';
const eventName = 'tjuclaw-campus-notes-changed';
const memory = new Map<string, string>();
const keyFor = (identity: string, library: string) => `tjuclaw.campus.notes.v1.${identity}.${library}`;

function read(key: string): string {
  if (memory.has(key)) return memory.get(key)!;
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function parseHiddenCampusNotes(raw: string): CampusNoteId[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter((id): id is CampusNoteId =>
      typeof id === 'string' && isCampusNoteId(id)))] : [];
  } catch { return []; }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null) memory.clear();
    else if (event.key.startsWith('tjuclaw.campus.notes.v1.')) memory.delete(event.key);
    else return;
    listener();
  };
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}

/** Only entry visibility is stored, per account and library; never a code or credential. */
export function useCampusNotes(identity: string, library: string) {
  const key = keyFor(identity, library);
  const raw = useSyncExternalStore(subscribe, () => read(key), () => '');
  const hidden = parseHiddenCampusNotes(raw);
  function setVisible(id: CampusNoteId, visible: boolean) {
    const current = parseHiddenCampusNotes(read(key));
    const next = JSON.stringify(visible ? current.filter(item => item !== id) : [...new Set([...current, id])]);
    memory.set(key, next);
    let persisted = true;
    try { localStorage.setItem(key, next); } catch { persisted = false; }
    window.dispatchEvent(new Event(eventName));
    return persisted;
  }
  return { hidden, setVisible };
}
