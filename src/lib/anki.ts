import { authRequest, AuthError } from './auth';

export type AnkiDeck = { id: string; name: string; description?: string; created_at: string; updated_at: string };
export type AnkiCard = { id: string; deck_id: string; template_id?: string; front: string; back: string; tags?: string[]; due: string; interval: number; ease: number; reps: number; lapses: number; created_at: string; updated_at: string };

function validCard(value: unknown): value is AnkiCard {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.deck_id === 'string' && typeof item.front === 'string' && typeof item.back === 'string'
    && typeof item.due === 'string' && typeof item.interval === 'number' && typeof item.reps === 'number';
}

function validDeck(value: unknown): value is AnkiDeck {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.created_at === 'string' && typeof item.updated_at === 'string';
}

export async function listDecks(signal?: AbortSignal): Promise<AnkiDeck[]> {
  const data = await authRequest<{ decks: unknown }>('/api/decks', { signal });
  if (!Array.isArray(data.decks) || !data.decks.every(validDeck)) throw new AuthError(503);
  return data.decks;
}

export async function createDeck(name: string, signal?: AbortSignal): Promise<AnkiDeck> {
  const data = await authRequest<{ deck: unknown }>('/api/decks', { method: 'POST', body: JSON.stringify({ name }), signal });
  if (!validDeck(data.deck)) throw new AuthError(503);
  return data.deck;
}

export async function listCards(deckId: string, signal?: AbortSignal): Promise<AnkiCard[]> {
  const data = await authRequest<{ cards: unknown }>(`/api/cards?deck_id=${encodeURIComponent(deckId)}`, { signal });
  if (!Array.isArray(data.cards) || !data.cards.every(validCard)) throw new AuthError(503);
  return data.cards;
}

export async function createCard(deckId: string, card: { front: string; back: string; tags?: string[] }, signal?: AbortSignal): Promise<AnkiCard> {
  const data = await authRequest<{ card: unknown }>('/api/cards', { method: 'POST', body: JSON.stringify({ deck_id: deckId, ...card }), signal });
  if (!validCard(data.card)) throw new AuthError(503);
  return data.card;
}

export async function patchCard(id: string, card: { front?: string; back?: string; tags?: string[] }, signal?: AbortSignal): Promise<AnkiCard> {
  const data = await authRequest<{ card: unknown }>(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify(card), signal });
  if (!validCard(data.card)) throw new AuthError(503);
  return data.card;
}

export async function deleteCard(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/cards/${id}`, { method: 'DELETE', signal });
}

export async function exportDeck(deckId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/export`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new AuthError(response.status);
  return response.blob();
}
