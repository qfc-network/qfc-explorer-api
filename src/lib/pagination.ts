export function parseNumber(value: string | undefined | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function parseSort(value: string | undefined | null, allowed: string[], fallback: string): string {
  if (!value) return fallback;
  return allowed.includes(value) ? value : fallback;
}

export function parseOrder(value: string | undefined | null): 'asc' | 'desc' {
  return value === 'asc' ? 'asc' : 'desc';
}
