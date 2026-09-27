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

export async function renameDeck(id: string, name: string, signal?: AbortSignal): Promise<AnkiDeck> {
  const data = await authRequest<{ deck: unknown }>(`/api/decks/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ name }), signal,
  });
  if (!validDeck(data.deck) || data.deck.id !== id) throw new AuthError(503);
  return data.deck;
}

export async function deleteDeck(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/decks/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
}

export async function listCards(deckId: string, signal?: AbortSignal): Promise<AnkiCard[]> {
  const data = await authRequest<{ cards: unknown }>(`/api/cards?deck_id=${encodeURIComponent(deckId)}`, { signal });
  if (!Array.isArray(data.cards) || !data.cards.every(validCard)) throw new AuthError(503);
  return data.cards;
}

export async function deckStudySummary(deckId: string, signal?: AbortSignal): Promise<number | null> {
  const data = await authRequest<{ last_reviewed_at: unknown }>(`/api/decks/${encodeURIComponent(deckId)}/study-summary`, { signal });
  if (data.last_reviewed_at === null) return null;
  if (typeof data.last_reviewed_at !== 'string' || !Number.isFinite(Date.parse(data.last_reviewed_at))) throw new AuthError(503);
  return Date.parse(data.last_reviewed_at);
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

export async function reviewCard(id: string, rating: 1 | 2 | 3 | 4, clientRequestId: string, signal?: AbortSignal): Promise<{ card: AnkiCard; reviewedAt: number }> {
  const data = await authRequest<{ card: unknown; review: unknown }>('/api/reviews', {
    method: 'POST',
    body: JSON.stringify({ card_id: id, rating, client_request_id: clientRequestId }),
    signal,
  });
  if (!validCard(data.card) || !data.review || typeof data.review !== 'object') throw new AuthError(503);
  const review = data.review as Record<string, unknown>;
  if (review.card_id !== id || review.client_request_id !== clientRequestId ||
    typeof review.reviewed_at !== 'string' || !Number.isFinite(Date.parse(review.reviewed_at))) throw new AuthError(503);
  return { card: data.card, reviewedAt: Date.parse(review.reviewed_at) };
}

export async function getReviewRequest(clientRequestId: string, signal?: AbortSignal): Promise<{ cardId: string; rating: number } | null> {
  try {
    const data = await authRequest<{ review: unknown }>(`/api/reviews/requests/${encodeURIComponent(clientRequestId)}`, { signal });
    if (!data.review || typeof data.review !== 'object') throw new AuthError(503);
    const review = data.review as Record<string, unknown>;
    if (review.client_request_id !== clientRequestId || typeof review.card_id !== 'string' ||
      !Number.isInteger(review.rating) || (review.rating as number) < 1 || (review.rating as number) > 4) throw new AuthError(503);
    return { cardId: review.card_id, rating: review.rating as number };
  } catch (error) {
    if (error instanceof AuthError && error.status === 404) return null;
    throw error;
  }
}

export async function exportDeck(deckId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/export`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new AuthError(response.status);
  return response.blob();
}

export async function importDeck(name: string, tsv: string, signal?: AbortSignal): Promise<{ deck: AnkiDeck; cards: AnkiCard[] }> {
  const data = await authRequest<{ deck: unknown; cards: unknown }>('/api/decks/import', {
    method: 'POST', body: JSON.stringify({ name, tsv }), signal,
  });
  if (!validDeck(data.deck) || !Array.isArray(data.cards) || !data.cards.every(validCard) ||
    data.cards.some(card => card.deck_id !== (data.deck as AnkiDeck).id)) throw new AuthError(503);
  return { deck: data.deck, cards: data.cards };
}
