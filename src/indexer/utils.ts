export function hexToBigIntString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  try {
    return BigInt(normalized).toString(10);
  } catch {
    return null;
  }
}

export function hexToNumber(value: string | null | undefined): number | null {
  const parsed = hexToBigIntString(value);
  if (parsed === null) {
    return null;
  }
  const asNumber = Number(parsed);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

// Below this, a timestamp can only be seconds: 1e12 ms is 2001, before the
// chain existed, while 1e12 seconds is year 33658.
const MS_THRESHOLD = 1_000_000_000_000n;

/**
 * Convert an RPC block timestamp (hex) to milliseconds. qfc-core emitted
 * milliseconds before PR #139 and Unix seconds (Ethereum-standard) after,
 * so detect the unit rather than assume one.
 */
export function rpcTimestampToMs(value: string | null | undefined): bigint | null {
  const parsed = hexToBigIntString(value);
  if (parsed === null) {
    return null;
  }
  const ts = BigInt(parsed);
  return ts < MS_THRESHOLD ? ts * 1000n : ts;
}

export function hexToBuffer(value: string | null | undefined): Buffer | null {
  if (!value) {
    return null;
  }
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (normalized.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.from(normalized, 'hex');
}

export function stripHexPrefix(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.startsWith('0x') ? value.slice(2) : value;
}

export function parseAddressFromTopic(topic: string): string | null {
  if (!topic) {
    return null;
  }
  const hex = topic.startsWith('0x') ? topic.slice(2) : topic;
  if (hex.length < 40) {
    return null;
  }
  return `0x${hex.slice(-40)}`.toLowerCase();
}

export function decodeUint256(hexValue: string): string | null {
  const stripped = stripHexPrefix(hexValue);
  if (!stripped) {
    return null;
  }
  try {
    return BigInt(`0x${stripped}`).toString(10);
  } catch {
    return null;
  }
}

export function decodeUint256Pair(hexValue: string): { id: string; value: string } | null {
  const stripped = stripHexPrefix(hexValue);
  if (!stripped || stripped.length < 128) {
    return null;
  }
  try {
    const id = BigInt(`0x${stripped.slice(0, 64)}`).toString(10);
    const value = BigInt(`0x${stripped.slice(64, 128)}`).toString(10);
    return { id, value };
  } catch {
    return null;
  }
}

export function decodeUint256Arrays(hexValue: string): Array<{ id: string; value: string }> | null {
  const stripped = stripHexPrefix(hexValue);
  if (!stripped || stripped.length < 256) {
    return null;
  }
  try {
    const idsOffset = Number(BigInt(`0x${stripped.slice(0, 64)}`)) * 2;
    const valuesOffset = Number(BigInt(`0x${stripped.slice(64, 128)}`)) * 2;
    const idsLen = Number(BigInt(`0x${stripped.slice(idsOffset, idsOffset + 64)}`));
    const valuesLen = Number(BigInt(`0x${stripped.slice(valuesOffset, valuesOffset + 64)}`));
    if (idsLen !== valuesLen || idsLen === 0) return null;
    const results: Array<{ id: string; value: string }> = [];
    for (let i = 0; i < idsLen; i++) {
      const idStart = idsOffset + 64 + i * 64;
      const valStart = valuesOffset + 64 + i * 64;
      const id = BigInt(`0x${stripped.slice(idStart, idStart + 64)}`).toString(10);
      const value = BigInt(`0x${stripped.slice(valStart, valStart + 64)}`).toString(10);
      results.push({ id, value });
    }
    return results;
  } catch {
    return null;
  }
}

export function decodeString(hexValue: string): string | null {
  const stripped = stripHexPrefix(hexValue);
  if (!stripped || stripped.length < 64) {
    return null;
  }
  try {
    const offset = Number(BigInt(`0x${stripped.slice(0, 64)}`));
    const lenStart = offset * 2;
    const lenHex = stripped.slice(lenStart, lenStart + 64);
    const length = Number(BigInt(`0x${lenHex}`));
    const dataStart = lenStart + 64;
    const dataHex = stripped.slice(dataStart, dataStart + length * 2);
    const buf = Buffer.from(dataHex, 'hex');
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
