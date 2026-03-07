import { hexToBigIntString, hexToBuffer } from '../utils.js';

describe('indexer utils', () => {
  test('hexToBigIntString parses hex', () => {
    expect(hexToBigIntString('0x10')).toBe('16');
  });

  test('hexToBigIntString returns null on invalid', () => {
    expect(hexToBigIntString('0xZZ')).toBeNull();
  });

  test('hexToBuffer handles empty', () => {
    expect(hexToBuffer('0x')).toEqual(Buffer.alloc(0));
  });
});
