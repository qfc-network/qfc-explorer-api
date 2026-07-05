import { hexToBigIntString, hexToBuffer, rpcTimestampToMs } from '../utils.js';

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

  test('rpcTimestampToMs scales Unix seconds to ms', () => {
    // 0x6a4a8d0d = 1783270669 s (2026-07-05, post-#139 RPC)
    expect(rpcTimestampToMs('0x6a4a8d0d')).toBe(1783270669000n);
  });

  test('rpcTimestampToMs passes milliseconds through', () => {
    // 0x19f37c8b3e8 = 1783347327976 ms (pre-#139 RPC)
    expect(rpcTimestampToMs('0x19f37c8b3e8')).toBe(1783347327976n);
  });

  test('rpcTimestampToMs returns null on invalid input', () => {
    expect(rpcTimestampToMs('0xZZ')).toBeNull();
    expect(rpcTimestampToMs(undefined)).toBeNull();
  });
});
