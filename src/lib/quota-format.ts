/** The numbers of one allowance window; `unit` is 'tokens' or absent on a server that counted turns. */
export interface QuotaAmount { limit: number; used: number; remaining: number; unit?: string }

/** A token count in 万 / 亿, as Chinese readers write large numbers. */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  const trim = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e8) return `${trim(n / 1e8)} 亿`;
  if (n >= 1e4) return `${trim(n / 1e4)} 万`;
  return String(n);
}

/** Used and limit of a window, in its own unit. */
export const formatQuotaUse = (window: QuotaAmount) => window.unit === 'tokens'
  ? `${formatTokens(window.used)} / ${formatTokens(window.limit)} tokens`
  : `${window.used} / ${window.limit}`;

/** The share of a window that is left, as a whole percentage. */
export const quotaShareLeft = (window: QuotaAmount) => window.limit > 0 ? Math.max(0, Math.min(100, Math.round(window.remaining / window.limit * 100))) : 0;

/** A model's rate as shown next to its name: '' at the base rate. */
export const formatModelRate = (rate: number | undefined) => !rate || rate === 1 ? '' : `${Number(rate.toFixed(2))} 倍额度`;
