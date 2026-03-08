/**
 * Multisig wallet detection — Safe (Gnosis Safe) proxy contracts.
 *
 * Detects Safe wallets by:
 *   1. Reading the EIP-1967 implementation slot to find the master copy
 *   2. Matching against known Safe master copy addresses
 *   3. Calling getOwners(), getThreshold(), nonce() on the contract
 */

import { rpcCallSafe } from './rpc.js';

// Known Safe master copy addresses (checksummed → lowercased for comparison)
const SAFE_MASTER_COPIES: Record<string, string> = {
  // Safe v1.3.0 — L1 & L2
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': '1.3.0',
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e': '1.3.0-L2',
  // Safe v1.4.1 — L1 & L2
  '0x41675c099f32341bf84bfc5382af534df5c7461a': '1.4.1',
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': '1.4.1-L2',
};

// EIP-1967 implementation storage slot:
// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// Safe proxy stores master copy at storage slot 0
const MASTER_COPY_SLOT = '0x0';

export interface MultisigInfo {
  type: 'safe';
  version: string;
  owners: string[];
  threshold: number;
  nonce: number;
}

/**
 * Detect if an address is a Safe (Gnosis) multisig wallet.
 * Returns multisig info or null if not detected.
 * Gracefully returns null on any RPC failure.
 */
export async function detectMultisig(address: string): Promise<MultisigInfo | null> {
  try {
    // Step 1: Try to identify the Safe master copy address.
    // Check EIP-1967 implementation slot first, then fallback to slot 0.
    let masterCopy: string | null = null;
    let version: string | null = null;

    // Try EIP-1967 implementation slot
    const implSlotValue = await rpcCallSafe<string>('eth_getStorageAt', [
      address,
      EIP1967_IMPL_SLOT,
      'latest',
    ]);

    if (implSlotValue && implSlotValue !== '0x' && implSlotValue !== '0x' + '0'.repeat(64)) {
      const addr = '0x' + implSlotValue.slice(-40).toLowerCase();
      if (SAFE_MASTER_COPIES[addr]) {
        masterCopy = addr;
        version = SAFE_MASTER_COPIES[addr];
      }
    }

    // Fallback: Safe proxy stores master copy at storage slot 0
    if (!version) {
      const slot0Value = await rpcCallSafe<string>('eth_getStorageAt', [
        address,
        MASTER_COPY_SLOT,
        'latest',
      ]);

      if (slot0Value && slot0Value !== '0x' && slot0Value !== '0x' + '0'.repeat(64)) {
        const addr = '0x' + slot0Value.slice(-40).toLowerCase();
        if (SAFE_MASTER_COPIES[addr]) {
          masterCopy = addr;
          version = SAFE_MASTER_COPIES[addr];
        }
      }
    }

    if (!version || !masterCopy) {
      return null;
    }

    // Step 2: Call getOwners() — selector 0xa0e67e2b
    const ownersRaw = await rpcCallSafe<string>('eth_call', [
      { to: address, data: '0xa0e67e2b' },
      'latest',
    ]);

    if (!ownersRaw || ownersRaw === '0x') {
      return null;
    }

    const owners = decodeAddressArray(ownersRaw);
    if (!owners || owners.length === 0) {
      return null;
    }

    // Step 3: Call getThreshold() — selector 0xe75235b8
    const thresholdRaw = await rpcCallSafe<string>('eth_call', [
      { to: address, data: '0xe75235b8' },
      'latest',
    ]);

    if (!thresholdRaw || thresholdRaw === '0x') {
      return null;
    }

    const threshold = decodeUint256(thresholdRaw);

    // Step 4: Call nonce() — selector 0xaffed0e0
    const nonceRaw = await rpcCallSafe<string>('eth_call', [
      { to: address, data: '0xaffed0e0' },
      'latest',
    ]);

    if (!nonceRaw || nonceRaw === '0x') {
      return null;
    }

    const nonce = decodeUint256(nonceRaw);

    return {
      type: 'safe',
      version,
      owners,
      threshold,
      nonce,
    };
  } catch {
    return null;
  }
}

/**
 * Decode an ABI-encoded address[] return value.
 * Layout: [offset (32 bytes)][length (32 bytes)][address1 (32 bytes)]...
 */
function decodeAddressArray(raw: string): string[] | null {
  try {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (hex.length < 128) return null; // minimum: offset + length + 1 address

    // Read offset (should be 0x20 = 32 for a simple dynamic array)
    const offset = parseInt(hex.slice(0, 64), 16) * 2; // offset in hex chars
    // Read array length
    const length = parseInt(hex.slice(offset, offset + 64), 16);
    if (length === 0 || length > 50) return null; // sanity check

    const addresses: string[] = [];
    for (let i = 0; i < length; i++) {
      const start = offset + 64 + i * 64;
      const addrHex = hex.slice(start + 24, start + 64); // last 20 bytes
      if (addrHex.length !== 40) return null;
      addresses.push('0x' + addrHex.toLowerCase());
    }

    return addresses;
  } catch {
    return null;
  }
}

/**
 * Decode a uint256 return value to a number.
 */
function decodeUint256(raw: string): number {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  return parseInt(hex.slice(0, 64), 16);
}
