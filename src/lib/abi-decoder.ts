/**
 * Lightweight ABI decoder — decodes transaction input data and event logs
 * using stored ABI JSON from verified contracts.
 *
 * No external dependencies — pure hex parsing with ABI fragment matching.
 */

import { keccak256 } from 'js-sha3';

// --- Types ---

export type AbiItem = {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  anonymous?: boolean;
  stateMutability?: string;
};

type AbiParam = {
  name: string;
  type: string;
  indexed?: boolean;
  components?: AbiParam[];
};

export type DecodedFunction = {
  name: string;
  signature: string;
  selector: string;
  params: DecodedParam[];
};

export type DecodedEvent = {
  name: string;
  signature: string;
  topic0: string;
  params: DecodedParam[];
};

type DecodedParam = {
  name: string;
  type: string;
  value: string;
};

// --- Signature helpers ---

function paramTypeStr(p: AbiParam): string {
  if (p.type === 'tuple' && p.components) {
    return `(${p.components.map(paramTypeStr).join(',')})`;
  }
  if (p.type.startsWith('tuple[') && p.components) {
    const suffix = p.type.slice(5); // e.g. "[]" or "[3]"
    return `(${p.components.map(paramTypeStr).join(',')})${suffix}`;
  }
  return p.type;
}

function buildSignature(name: string, inputs: AbiParam[]): string {
  return `${name}(${inputs.map(paramTypeStr).join(',')})`;
}

function computeSelector(sig: string): string {
  return '0x' + keccak256(sig).slice(0, 8);
}

function computeTopic0(sig: string): string {
  return '0x' + keccak256(sig);
}

// --- ABI indexing ---

type FunctionEntry = { item: AbiItem; signature: string; selector: string };
type EventEntry = { item: AbiItem; signature: string; topic0: string };

export function indexAbi(abi: AbiItem[]): { functions: Map<string, FunctionEntry>; events: Map<string, EventEntry> } {
  const functions = new Map<string, FunctionEntry>();
  const events = new Map<string, EventEntry>();

  for (const item of abi) {
    if (!item.name) continue;
    const inputs = item.inputs ?? [];

    if (item.type === 'function') {
      const sig = buildSignature(item.name, inputs);
      const sel = computeSelector(sig);
      functions.set(sel, { item, signature: sig, selector: sel });
    } else if (item.type === 'event') {
      const sig = buildSignature(item.name, inputs);
      const t0 = computeTopic0(sig);
      events.set(t0, { item, signature: sig, topic0: t0 });
    }
  }

  return { functions, events };
}

// --- Decoding ---

/** Decode a single ABI-encoded word (32 bytes) by type */
function decodeWord(hex: string, type: string): string {
  if (type === 'address') {
    return '0x' + hex.slice(24).toLowerCase();
  }
  if (type === 'bool') {
    return parseInt(hex, 16) !== 0 ? 'true' : 'false';
  }
  if (type.startsWith('uint')) {
    return BigInt('0x' + hex).toString();
  }
  if (type.startsWith('int')) {
    // Signed integer
    const bits = parseInt(type.slice(3)) || 256;
    const val = BigInt('0x' + hex);
    const max = 1n << BigInt(bits);
    const half = max / 2n;
    return (val >= half ? val - max : val).toString();
  }
  if (type.startsWith('bytes') && !type.endsWith('[]') && type !== 'bytes') {
    const len = parseInt(type.slice(5));
    return '0x' + hex.slice(0, len * 2);
  }
  return '0x' + hex;
}

/** Decode calldata (input) for a function using ABI */
export function decodeFunction(inputHex: string, abi: AbiItem[]): DecodedFunction | null {
  if (!inputHex || inputHex.length < 10) return null;
  const selector = inputHex.slice(0, 10).toLowerCase();
  const { functions } = indexAbi(abi);
  const entry = functions.get(selector);
  if (!entry) return null;

  const params = decodeParams(inputHex.slice(10), entry.item.inputs ?? []);
  return {
    name: entry.item.name!,
    signature: entry.signature,
    selector,
    params,
  };
}

/** Decode event log using ABI */
export function decodeEvent(
  topics: string[],
  data: string,
  abi: AbiItem[]
): DecodedEvent | null {
  if (!topics || topics.length === 0) return null;
  const topic0 = topics[0].toLowerCase();
  const { events } = indexAbi(abi);
  const entry = events.get(topic0);
  if (!entry) return null;

  const inputs = entry.item.inputs ?? [];
  const params: DecodedParam[] = [];
  let topicIdx = 1;
  let dataOffset = 0;
  const cleanData = (data || '0x').slice(2);

  for (const input of inputs) {
    if (input.indexed) {
      // Indexed params come from topics
      if (topicIdx < topics.length) {
        const topicHex = topics[topicIdx].slice(2);
        params.push({ name: input.name, type: input.type, value: decodeWord(topicHex, input.type) });
        topicIdx++;
      }
    } else {
      // Non-indexed params from data
      if (dataOffset + 64 <= cleanData.length) {
        const word = cleanData.slice(dataOffset, dataOffset + 64);
        if (input.type === 'string' || input.type === 'bytes') {
          params.push({ name: input.name, type: input.type, value: decodeDynamic(cleanData, dataOffset) });
        } else {
          params.push({ name: input.name, type: input.type, value: decodeWord(word, input.type) });
        }
        dataOffset += 64;
      }
    }
  }

  return {
    name: entry.item.name!,
    signature: entry.signature,
    topic0,
    params,
  };
}

function decodeParams(dataHex: string, inputs: AbiParam[]): DecodedParam[] {
  const params: DecodedParam[] = [];
  let offset = 0;

  for (const input of inputs) {
    if (offset + 64 > dataHex.length) break;
    const word = dataHex.slice(offset, offset + 64);

    if (input.type === 'string' || input.type === 'bytes') {
      params.push({ name: input.name, type: input.type, value: decodeDynamic(dataHex, offset) });
    } else if (input.type.endsWith('[]')) {
      // Dynamic array — just show offset pointer for now
      params.push({ name: input.name, type: input.type, value: `[dynamic array at offset ${parseInt(word, 16)}]` });
    } else {
      params.push({ name: input.name, type: input.type, value: decodeWord(word, input.type) });
    }
    offset += 64;
  }

  return params;
}

function decodeDynamic(fullDataHex: string, wordOffset: number): string {
  try {
    const pointerWord = fullDataHex.slice(wordOffset, wordOffset + 64);
    const pointer = parseInt(pointerWord, 16) * 2; // byte offset → hex char offset
    const lenWord = fullDataHex.slice(pointer, pointer + 64);
    const len = parseInt(lenWord, 16);
    const strHex = fullDataHex.slice(pointer + 64, pointer + 64 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8');
  } catch {
    return '0x' + fullDataHex.slice(wordOffset, wordOffset + 64);
  }
}

// --- Batch helper ---

/** Look up ABI for a contract address, returns null if not verified */
export async function getContractAbi(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ abi: string }> }> },
  address: string
): Promise<AbiItem[] | null> {
  const result = await pool.query(
    'SELECT abi FROM contracts WHERE address = $1 AND is_verified = true AND abi IS NOT NULL LIMIT 1',
    [address]
  );
  if (result.rows.length === 0) return null;
  try {
    return JSON.parse(result.rows[0].abi);
  } catch {
    return null;
  }
}
