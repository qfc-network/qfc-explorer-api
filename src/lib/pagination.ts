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

// --- Cursor-based pagination helpers ---

export function encodeCursor(field: string, value: string): string {
  return Buffer.from(JSON.stringify({ field, value })).toString('base64url');
}

export function parseCursor(cursor: string): { field: string; value: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof obj.field === 'string' && typeof obj.value === 'string') {
      return { field: obj.field, value: obj.value };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeTxCursor(blockHeight: string, txIndex: string): string {
  return Buffer.from(JSON.stringify({ block_height: blockHeight, tx_index: txIndex })).toString('base64url');
}

export function parseTxCursor(cursor: string): { block_height: string; tx_index: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof obj.block_height === 'string' && typeof obj.tx_index === 'string') {
      return { block_height: obj.block_height, tx_index: obj.tx_index };
    }
    return null;
  } catch {
    return null;
  }
}
