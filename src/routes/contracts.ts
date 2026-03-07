import { FastifyInstance } from 'fastify';
import { getPool, getReadPool } from '../db/pool.js';
import { rpcCall, rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber } from '../lib/pagination.js';
import { cached, cacheGet, cacheSet } from '../lib/cache.js';

// EIP-1967 / EIP-1822 storage slots
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1822_SLOT = '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

const ZERO_ADDR = '0x' + '0'.repeat(40);

function extractAddress(slot: string | null): string | null {
  if (!slot || slot === '0x' || slot === '0x' + '0'.repeat(64)) return null;
  const addr = '0x' + slot.slice(-40);
  return addr === ZERO_ADDR ? null : addr;
}

async function detectProxy(address: string) {
  // EIP-1967 implementation
  const implSlot = await rpcCallSafe<string>('eth_getStorageAt', [address, EIP1967_IMPL_SLOT, 'latest']);
  const implAddr = extractAddress(implSlot);
  if (implAddr) return { proxy_type: 'EIP-1967', implementation_address: implAddr };

  // EIP-1822 (UUPS)
  const uupsSlot = await rpcCallSafe<string>('eth_getStorageAt', [address, EIP1822_SLOT, 'latest']);
  const uupsAddr = extractAddress(uupsSlot);
  if (uupsAddr) return { proxy_type: 'EIP-1822 (UUPS)', implementation_address: uupsAddr };

  // Beacon proxy
  const beaconSlot = await rpcCallSafe<string>('eth_getStorageAt', [address, EIP1967_BEACON_SLOT, 'latest']);
  const beaconAddr = extractAddress(beaconSlot);
  if (beaconAddr) return { proxy_type: 'Beacon Proxy', implementation_address: beaconAddr };

  return { proxy_type: null, implementation_address: null };
}

export default async function contractsRoutes(app: FastifyInstance) {
  // GET /contract/:address — deep contract info
  app.get('/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      reply.status(400);
      return { ok: false, error: 'Invalid address format' };
    }

    const cacheKey = `contract:${address.toLowerCase()}`;
    const hit = await cacheGet(cacheKey);
    if (hit) return { ok: true, data: hit };

    const pool = getReadPool();

    // RPC calls
    const [code, balance, nonce] = await Promise.all([
      rpcCallSafe<string>('eth_getCode', [address, 'latest']),
      rpcCallSafe<string>('eth_getBalance', [address, 'latest']),
      rpcCallSafe<string>('eth_getTransactionCount', [address, 'latest']),
    ]);

    const isContract = !!code && code !== '0x' && code !== '0x0';

    // DB contract info
    const contractRow = await pool.query(
      `SELECT creator_tx_hash, created_at_block, code_hash,
              is_verified, source_code, abi, compiler_version, evm_version,
              optimization_runs, verified_at
       FROM contracts WHERE address = $1 LIMIT 1`,
      [address]
    );
    const contract = contractRow.rows[0];

    // Proxy detection
    const proxy = isContract ? await detectProxy(address) : { proxy_type: null, implementation_address: null };

    // Similar contracts
    let similar_contracts: Array<{ address: string; is_verified: boolean }> = [];
    if (contract?.code_hash) {
      const simResult = await pool.query(
        `SELECT address, COALESCE(is_verified, false) AS is_verified
         FROM contracts WHERE code_hash = $1 AND address != $2 LIMIT 10`,
        [contract.code_hash, address]
      );
      similar_contracts = simResult.rows;
    }

    const data = {
        address,
        code: code || '0x',
        balance: balance ? BigInt(balance).toString() : '0',
        nonce: nonce ? parseInt(nonce, 16).toString() : '0',
        is_contract: isContract,
        creator_tx: contract?.creator_tx_hash ?? null,
        created_at_block: contract?.created_at_block?.toString() ?? null,
        is_verified: contract?.is_verified ?? false,
        source_code: contract?.source_code ?? null,
        abi: contract?.abi ?? null,
        compiler_version: contract?.compiler_version ?? null,
        evm_version: contract?.evm_version ?? null,
        optimization_runs: contract?.optimization_runs ?? null,
        verified_at: contract?.verified_at ?? null,
        similar_contracts,
        ...proxy,
    };
    await cacheSet(cacheKey, data, 30);
    return { ok: true, data };
  });

  // POST /contract/call — read-only contract call
  app.post('/call', async (request, reply) => {
    const body = request.body as {
      address: string;
      function: string;
      inputs?: Array<{ type: string; value: string }>;
    };

    if (!body.address || !body.function) {
      reply.status(400);
      return { ok: false, error: 'Missing address or function' };
    }

    const FUNCTION_SELECTORS: Record<string, string> = {
      name: '0x06fdde03',
      symbol: '0x95d89b41',
      decimals: '0x313ce567',
      totalSupply: '0x18160ddd',
      balanceOf: '0x70a08231',
      allowance: '0xdd62ed3e',
      owner: '0x8da5cb5b',
      ownerOf: '0x6352211e',
      tokenURI: '0xc87b56dd',
    };

    const selector = FUNCTION_SELECTORS[body.function];
    if (!selector) {
      reply.status(400);
      return { ok: false, error: `Unknown function: ${body.function}` };
    }

    let data = selector;
    if (body.inputs) {
      for (const input of body.inputs) {
        if (input.type === 'address') {
          data += input.value.replace('0x', '').padStart(64, '0');
        } else if (input.type.startsWith('uint')) {
          data += BigInt(input.value).toString(16).padStart(64, '0');
        } else if (input.type === 'bool') {
          data += (input.value === 'true' ? '1' : '0').padStart(64, '0');
        } else if (input.type === 'bytes32') {
          data += input.value.replace('0x', '').padEnd(64, '0');
        }
      }
    }

    const raw = await rpcCallSafe<string>('eth_call', [
      { to: body.address, data },
      'latest',
    ]);

    if (!raw || raw === '0x') {
      return { ok: true, data: { function: body.function, raw: raw || '0x', result: null } };
    }

    // Decode result
    let result: string | null = null;
    const fn = body.function;
    if (fn === 'name' || fn === 'symbol' || fn === 'tokenURI') {
      // Dynamic string
      try {
        const hex = raw.slice(2);
        const offset = parseInt(hex.slice(0, 64), 16) * 2;
        const len = parseInt(hex.slice(offset, offset + 64), 16);
        const strHex = hex.slice(offset + 64, offset + 64 + len * 2);
        result = Buffer.from(strHex, 'hex').toString('utf8');
      } catch {
        result = raw;
      }
    } else if (fn === 'decimals') {
      result = parseInt(raw, 16).toString();
    } else if (fn === 'totalSupply' || fn === 'balanceOf' || fn === 'allowance') {
      result = BigInt(raw).toString();
    } else if (fn === 'owner' || fn === 'ownerOf') {
      result = '0x' + raw.slice(-40);
    }

    return { ok: true, data: { function: body.function, raw, result } };
  });

  // GET /contract/list — paginated contracts
  app.get('/', async (request) => {
    const q = request.query as Record<string, string>;
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const offset = parseNumber(q.offset, 0);
    const pool = getReadPool();
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT address, creator_tx_hash, created_at_block, is_verified
         FROM contracts ORDER BY created_at_block DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) AS total FROM contracts'),
    ]);
    return {
      ok: true,
      data: { items: items.rows, total: Number(total.rows[0].total), limit, offset },
    };
  });

  // GET /contract/verified — top verified contracts
  app.get('/verified', async () => {
    const data = await cached('contracts:verified', 60, async () => {
    const pool = getReadPool();
    const result = await pool.query(`
      SELECT c.address, c.creator_tx_hash, c.created_at_block, c.compiler_version, c.verified_at,
             t.name AS token_name, t.symbol AS token_symbol,
             (SELECT COUNT(*) FROM transactions
              WHERE to_address = c.address)::int AS interaction_count
      FROM contracts c
      LEFT JOIN tokens t ON t.address = c.address
      WHERE c.is_verified = true
      ORDER BY interaction_count DESC
      LIMIT 50
    `);
    const total = await pool.query('SELECT COUNT(*) AS c FROM contracts WHERE is_verified = true');
    return { items: result.rows, total: Number(total.rows[0].c) };
    });
    return { ok: true, data };
  });

  // POST /contract/verify — source code verification
  app.post('/verify', async (request, reply) => {
    const body = request.body as {
      address: string;
      sourceCode: string;
      compilerVersion: string;
      evmVersion?: string;
      optimizationRuns?: number;
      constructorArgs?: string;
    };

    if (!body.address || !body.sourceCode || !body.compilerVersion) {
      reply.status(400);
      return { ok: false, error: 'Missing required fields: address, sourceCode, compilerVersion' };
    }

    // Fetch deployed bytecode
    const deployedCode = await rpcCallSafe<string>('eth_getCode', [body.address, 'latest']);
    if (!deployedCode || deployedCode === '0x') {
      reply.status(400);
      return { ok: false, error: 'No contract code at this address' };
    }

    try {
      // Dynamic import solc (optional dependency)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const solc = await import(/* webpackIgnore: true */ 'solc' as string) as { compile: (input: string) => string };
      const evmVersion = body.evmVersion || 'paris';
      const input = JSON.stringify({
        language: 'Solidity',
        sources: { 'contract.sol': { content: body.sourceCode } },
        settings: {
          evmVersion,
          optimizer: body.optimizationRuns
            ? { enabled: true, runs: body.optimizationRuns }
            : { enabled: false },
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
        },
      });

      const output = JSON.parse(solc.compile(input));
      if (output.errors?.some((e: { severity: string }) => e.severity === 'error')) {
        reply.status(400);
        return {
          ok: false,
          error: 'Compilation failed',
          details: output.errors.filter((e: { severity: string }) => e.severity === 'error'),
        };
      }

      // Find matching contract
      const contracts = output.contracts?.['contract.sol'] || {};
      for (const [contractName, contractData] of Object.entries(contracts)) {
        const compiled = (contractData as { evm: { deployedBytecode: { object: string } } }).evm.deployedBytecode.object;
        const abi = (contractData as { abi: unknown[] }).abi;

        // Strip CBOR metadata for comparison
        const stripMeta = (hex: string) => {
          const clean = hex.replace(/^0x/, '');
          if (clean.length < 4) return clean;
          const metaLen = parseInt(clean.slice(-4), 16) * 2 + 4;
          return metaLen < clean.length ? clean.slice(0, clean.length - metaLen) : clean;
        };

        const deployedStripped = stripMeta(deployedCode);
        const compiledStripped = stripMeta(compiled);

        if (deployedStripped === compiledStripped) {
          // Match found — store in DB
          const pool = getPool();
          await pool.query(
            `UPDATE contracts SET
               source_code = $2, abi = $3, compiler_version = $4,
               evm_version = $5, optimization_runs = $6,
               is_verified = true, verified_at = NOW()
             WHERE address = $1`,
            [body.address, body.sourceCode, JSON.stringify(abi),
             body.compilerVersion, evmVersion, body.optimizationRuns || null]
          );

          return {
            ok: true,
            data: {
              address: body.address,
              verified: true,
              contractName,
              compiler: body.compilerVersion,
              evmVersion,
              optimizationRuns: body.optimizationRuns || null,
            },
          };
        }
      }

      reply.status(400);
      return { ok: false, error: 'Bytecode mismatch — verification failed' };
    } catch (error) {
      reply.status(500);
      return { ok: false, error: error instanceof Error ? error.message : 'Verification failed' };
    }
  });
}
