import { FastifyInstance } from 'fastify';
import sha3 from 'js-sha3';
const { keccak256 } = sha3;

// In-memory map of known 4-byte function selectors
const METHOD_SELECTORS: Record<string, string> = {
  // ERC-20
  'a9059cbb': 'transfer(address,uint256)',
  '095ea7b3': 'approve(address,uint256)',
  '23b872dd': 'transferFrom(address,address,uint256)',
  '70a08231': 'balanceOf(address)',
  'dd62ed3e': 'allowance(address,address)',
  '18160ddd': 'totalSupply()',
  '06fdde03': 'name()',
  '95d89b41': 'symbol()',
  '313ce567': 'decimals()',
  '40c10f19': 'mint(address,uint256)',
  '42966c68': 'burn(uint256)',
  '79cc6790': 'burnFrom(address,uint256)',
  '39509351': 'increaseAllowance(address,uint256)',
  'a457c2d7': 'decreaseAllowance(address,uint256)',
  'd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  // ERC-721
  '42842e0e': 'safeTransferFrom(address,address,uint256)',
  'b88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '6352211e': 'ownerOf(uint256)',
  'a22cb465': 'setApprovalForAll(address,bool)',
  'e985e9c5': 'isApprovedForAll(address,address)',
  '081812fc': 'getApproved(uint256)',
  'c87b56dd': 'tokenURI(uint256)',
  '4f6ccce7': 'tokenByIndex(uint256)',
  '2f745c59': 'tokenOfOwnerByIndex(address,uint256)',
  '01ffc9a7': 'supportsInterface(bytes4)',
  // ERC-1155
  'f242432a': 'safeTransferFrom(address,address,uint256,uint256,bytes)',
  '2eb2c2d6': 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  '00fdd58e': 'balanceOf(address,uint256)',
  '4e1273f4': 'balanceOfBatch(address[],uint256[])',
  '0e89341c': 'uri(uint256)',
  // Uniswap V2 Router
  '38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '8803dbee': 'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
  '7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '4a25d94a': 'swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
  '18cbafe5': 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  'fb3bdb41': 'swapETHForExactTokens(uint256,address[],address,uint256)',
  'e8e33700': 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  'f305d719': 'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  'baa2abde': 'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
  '02751cec': 'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  // Uniswap V3 Router
  '414bf389': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'c04b8d59': 'exactInput((bytes,address,uint256,uint256,uint256))',
  'db3e2198': 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'f28c0498': 'exactOutput((bytes,address,uint256,uint256,uint256))',
  'ac9650d8': 'multicall(bytes[])',
  '5ae401dc': 'multicall(uint256,bytes[])',
  // Uniswap V2 Pair
  '022c0d9f': 'swap(uint256,uint256,address,bytes)',
  '6a627842': 'mint(address)',
  '89afcb44': 'burn(address)',
  '0902f1ac': 'getReserves()',
  'fff6cae9': 'sync()',
  // DeFi
  '2e1a7d4d': 'withdraw(uint256)',
  'b6b55f25': 'deposit(uint256)',
  'e2bbb158': 'deposit(uint256,uint256)',
  '441a3e70': 'withdraw(uint256,uint256)',
  '1058d281': 'harvest(uint256)',
  'e9fad8ee': 'exit()',
  'a694fc3a': 'stake(uint256)',
  '2e17de78': 'unstake(uint256)',
  '3d18b912': 'getReward()',
  'd0e30db0': 'deposit()',
  '3ccfd60b': 'withdraw()',
  // Governance
  '7d5e81e2': 'propose(address[],uint256[],bytes[],string)',
  '56781388': 'castVote(uint256,uint8)',
  '5c19a95c': 'delegate(address)',
  // Access Control
  '8da5cb5b': 'owner()',
  '715018a6': 'renounceOwnership()',
  'f2fde38b': 'transferOwnership(address)',
  '2f2ff15d': 'grantRole(bytes32,address)',
  'd547741f': 'revokeRole(bytes32,address)',
  '91d14854': 'hasRole(bytes32,address)',
  // Proxy
  '3659cfe6': 'upgradeTo(address)',
  '4f1ef286': 'upgradeToAndCall(address,bytes)',
  '5c60da1b': 'implementation()',
  // Gnosis Safe
  '6a761202': 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
  // Misc
  '8456cb59': 'pause()',
  '3f4ba83a': 'unpause()',
  'c4d66de8': 'initialize(address)',
};

export default async function toolsRoutes(app: FastifyInstance) {
  // GET /tools/keccak256
  app.get('/keccak256', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!q.input) {
      reply.status(400);
      return { ok: false, error: 'Missing input parameter' };
    }
    const hash = '0x' + keccak256(q.input);
    return { ok: true, data: { input: q.input, hash } };
  });

  // GET /tools/method/:selector — look up a 4-byte function selector
  app.get('/method/:selector', async (request, reply) => {
    const { selector } = request.params as { selector: string };
    const clean = selector.startsWith('0x') ? selector.slice(2).toLowerCase() : selector.toLowerCase();

    if (!/^[0-9a-f]{8}$/.test(clean)) {
      reply.status(400);
      return { ok: false, error: 'Invalid selector — expected 4-byte hex (e.g. 0xa9059cbb)' };
    }

    const signature = METHOD_SELECTORS[clean] ?? null;
    const name = signature ? signature.split('(')[0] : null;

    return {
      ok: true,
      data: {
        selector: `0x${clean}`,
        signature,
        name,
      },
    };
  });
}
