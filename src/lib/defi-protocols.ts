/**
 * DeFi protocol recognition and transaction labeling.
 * Identifies transactions by their 4-byte function selector.
 */

export interface TransactionLabel {
  action: string;
  category: string;
  protocolName?: string;
  icon: string;
}

// Known function selectors -> protocol actions
const KNOWN_METHODS: Record<string, { action: string; category: string }> = {
  // DEX
  '0x38ed1739': { action: 'Swap Tokens (Exact Input)', category: 'dex' },
  '0x8803dbee': { action: 'Swap Tokens (Exact Output)', category: 'dex' },
  '0x7ff36ab5': { action: 'Swap ETH for Tokens', category: 'dex' },
  '0x18cbafe5': { action: 'Swap Tokens for ETH', category: 'dex' },
  '0xe8e33700': { action: 'Add Liquidity', category: 'dex' },
  '0xbaa2abde': { action: 'Remove Liquidity', category: 'dex' },
  '0x02751cec': { action: 'Remove Liquidity ETH', category: 'dex' },
  '0x5c11d795': { action: 'Swap Exact Tokens (Supporting Fee)', category: 'dex' },
  // ERC-20
  '0xa9059cbb': { action: 'Transfer', category: 'token' },
  '0x23b872dd': { action: 'Transfer From', category: 'token' },
  '0x095ea7b3': { action: 'Approve', category: 'token' },
  // NFT
  '0x42842e0e': { action: 'Safe Transfer (NFT)', category: 'nft' },
  '0xb88d4fde': { action: 'Safe Transfer (NFT) with Data', category: 'nft' },
  '0x1249c58b': { action: 'Mint', category: 'nft' },
  '0x40c10f19': { action: 'Mint To', category: 'nft' },
  '0x6a627842': { action: 'Mint', category: 'nft' },
  // Staking
  '0xa694fc3a': { action: 'Stake', category: 'staking' },
  '0x2e1a7d4d': { action: 'Withdraw', category: 'staking' },
  '0x3d18b912': { action: 'Claim Rewards', category: 'staking' },
  '0xe9fad8ee': { action: 'Exit (Unstake + Claim)', category: 'staking' },
  // Lending
  '0xe8eda9df': { action: 'Deposit (Lending)', category: 'lending' },
  '0x69328dec': { action: 'Withdraw (Lending)', category: 'lending' },
  '0xa415bcad': { action: 'Borrow', category: 'lending' },
  '0x573ade81': { action: 'Repay', category: 'lending' },
  // Governance
  '0xda95691a': { action: 'Propose', category: 'governance' },
  '0x56781388': { action: 'Cast Vote', category: 'governance' },
  '0x2656227d': { action: 'Queue Proposal', category: 'governance' },
  '0xfe0d94c1': { action: 'Execute Proposal', category: 'governance' },
  // Multicall
  '0xac9650d8': { action: 'Multicall', category: 'other' },
  '0x5ae401dc': { action: 'Multicall (with deadline)', category: 'other' },
};

const CATEGORY_ICONS: Record<string, string> = {
  dex: '\u{1F504}',         // recycling arrows
  lending: '\u{1F3E6}',     // bank
  staking: '\u{26A1}',      // lightning
  nft: '\u{1F3A8}',         // palette
  governance: '\u{1F5F3}',  // ballot box
  token: '\u{1F4B0}',       // money bag
  bridge: '\u{1F309}',      // bridge at night
  other: '\u{2699}',        // gear
};

const CATEGORY_COLORS: Record<string, string> = {
  dex: '#a855f7',        // purple
  lending: '#3b82f6',    // blue
  staking: '#22c55e',    // green
  nft: '#ec4899',        // pink
  governance: '#f59e0b', // amber
  token: '#06b6d4',      // cyan
  bridge: '#6366f1',     // indigo
  other: '#94a3b8',      // slate
};

/**
 * Identify a transaction by its input data selector and optional address label info.
 */
export function identifyTransaction(
  inputData: string | null | undefined,
  toAddress: string | null | undefined,
  value: string,
  addressLabel?: { category?: string | null; label?: string } | null,
): TransactionLabel | null {
  // Extract the 4-byte selector from input data
  if (!inputData || inputData === '0x' || inputData.length < 10) {
    // Plain ETH/QFC transfer (no input data)
    return null;
  }

  const selector = inputData.slice(0, 10).toLowerCase();
  const method = KNOWN_METHODS[selector];

  if (!method) {
    return null;
  }

  // If the target address has a label with category, use that as protocol name
  let protocolName: string | undefined;
  if (addressLabel?.label) {
    protocolName = addressLabel.label;
  }

  return {
    action: method.action,
    category: method.category,
    protocolName,
    icon: getCategoryIcon(method.category),
  };
}

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
}

export function getCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? CATEGORY_ICONS.other;
}
