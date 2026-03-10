import { FastifyInstance } from 'fastify';
import { getPool, getReadPool } from '../db/pool.js';
import { rpcCallSafe } from '../lib/rpc.js';
import { clamp, parseNumber, parseOrder } from '../lib/pagination.js';

/**
 * Etherscan-compatible API endpoints.
 *
 * Provides a subset of the Etherscan API so that third-party tools
 * (Hardhat, Foundry, MetaMask, etc.) can interact with the QFC explorer.
 *
 * Routes:
 *   GET  /etherscan/api?module=...&action=...
 *   POST /etherscan/api  (for verifysourcecode — used by hardhat-verify & forge verify-contract)
 */

type EtherscanResponse = {
  status: string;
  message: string;
  result: unknown;
};

function ok(result: unknown): EtherscanResponse {
  return { status: '1', message: 'OK', result };
}

function err(message: string): EtherscanResponse {
  return { status: '0', message: 'NOTOK', result: message };
}

export default async function etherscanRoutes(app: FastifyInstance) {
  // Hardhat sends application/x-www-form-urlencoded; Foundry may send JSON.
  // Register a form-urlencoded parser so we don't need @fastify/formbody.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed: Record<string, string> = {};
        for (const pair of (body as string).split('&')) {
          const [key, ...rest] = pair.split('=');
          if (key) parsed[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
        }
        done(null, parsed);
      } catch (e) {
        done(e instanceof Error ? e : new Error('Failed to parse form body'), undefined);
      }
    }
  );

  app.get('/api', async (request) => {
    const q = request.query as Record<string, string>;
    const module = (q.module || '').toLowerCase();
    const action = (q.action || '').toLowerCase();

    // --- module=account ---
    if (module === 'account') {
      if (action === 'txlist') {
        return handleTxList(q);
      }
      if (action === 'tokentx') {
        return handleTokenTx(q);
      }
      if (action === 'balance') {
        return handleBalance(q);
      }
      if (action === 'balancemulti') {
        return handleBalanceMulti(q);
      }
      if (action === 'tokenbalance') {
        return handleTokenBalance(q);
      }
      if (action === 'getminedblocks') {
        return handleGetMinedBlocks(q);
      }
      return err(`Unknown action: ${q.action}`);
    }

    // --- module=contract ---
    if (module === 'contract') {
      if (action === 'getabi') {
        return handleGetAbi(q);
      }
      if (action === 'getsourcecode') {
        return handleGetSourceCode(q);
      }
      if (action === 'checkverifystatus') {
        return handleCheckVerifyStatus(q);
      }
      return err(`Unknown action: ${q.action}`);
    }

    // --- module=logs ---
    if (module === 'logs') {
      if (action === 'getlogs') {
        return handleGetLogs(q);
      }
      return err(`Unknown action: ${q.action}`);
    }

    // --- module=stats ---
    if (module === 'stats') {
      if (action === 'ethsupply') {
        return handleEthSupply();
      }
      if (action === 'ethprice') {
        return handleEthPrice();
      }
      return err(`Unknown action: ${q.action}`);
    }

    // --- module=proxy ---
    if (module === 'proxy') {
      if (action === 'eth_blocknumber') {
        return handleEthBlockNumber();
      }
      if (action === 'eth_getblockbynumber') {
        return handleEthGetBlockByNumber(q);
      }
      return err(`Unknown action: ${q.action}`);
    }


    // --- module=transaction ---
    if (module === 'transaction') {
      if (action === 'gettxreceiptstatus' || action === 'getstatus') {
        const txhash = q.txhash;
        if (!txhash) return err('Missing txhash parameter');
        const pool = getReadPool();
        const row = await pool.query('SELECT status FROM transactions WHERE hash = $1 LIMIT 1', [txhash.toLowerCase()]);
        if (!row.rows[0]) return err('Transaction not found');
        const isOk = row.rows[0].status === 'success' || row.rows[0].status === '1' ? '1' : '0';
        if (action === 'getstatus') return ok({ isError: isOk === '1' ? '0' : '1', errDescription: '' });
        return ok({ status: isOk });
      }
      return err('Unknown action: ' + q.action);
    }

    // --- module=block ---
    if (module === 'block') {
      if (action === 'getblockreward') {
        const blockno = q.blockno;
        if (!blockno) return err('Missing blockno');
        const pool = getReadPool();
        const row = await pool.query('SELECT hash, height, producer, timestamp_ms, gas_used FROM blocks WHERE height = $1 LIMIT 1', [blockno]);
        if (!row.rows[0]) return err('Block not found');
        const b = row.rows[0];
        return ok({ blockNumber: String(b.height), timeStamp: String(Math.floor(Number(b.timestamp_ms)/1000)), blockMiner: b.producer ?? '', blockReward: '0', uncles: [], uncleInclusionReward: '0' });
      }
      if (action === 'getblockcountdown') {
        const blockno = Number(q.blockno);
        const pool = getReadPool();
        const latest = await pool.query('SELECT height FROM blocks ORDER BY height DESC LIMIT 1');
        const currentBlock = Number(latest.rows[0]?.height ?? 0);
        if (blockno <= currentBlock) return err('Block already passed');
        const remaining = blockno - currentBlock;
        return ok({ CurrentBlock: String(currentBlock), CountdownBlock: String(blockno), RemainingBlock: String(remaining), EstimateTimeInSec: String(remaining * 3) });
      }
      if (action === 'getblocknobytime') {
        const ts = Number(q.timestamp) * 1000;
        const closest = q.closest ?? 'before';
        const pool = getReadPool();
        const op = closest === 'after' ? '>=' : '<=';
        const ord = closest === 'after' ? 'ASC' : 'DESC';
        const row = await pool.query(`SELECT height FROM blocks WHERE timestamp_ms ${op} $1 ORDER BY height ${ord} LIMIT 1`, [ts]);
        if (!row.rows[0]) return err('Block not found');
        return ok(String(row.rows[0].height));
      }
      return err('Unknown action: ' + q.action);
    }

    // --- module=token ---
    if (module === 'token') {
      if (action === 'tokeninfo') {
        const addr = q.contractaddress;
        if (!addr) return err('Missing contractaddress');
        const pool = getReadPool();
        const row = await pool.query('SELECT address, name, symbol, decimals, total_supply FROM tokens WHERE address = LOWER($1) LIMIT 1', [addr]);
        if (!row.rows[0]) return err('Token not found');
        const t = row.rows[0];
        return ok([{ contractAddress: t.address, tokenName: t.name, symbol: t.symbol, divisor: String(Math.pow(10, Number(t.decimals))), tokenType: 'ERC-20', totalSupply: t.total_supply ?? '0', blueCheckmark: 'false', description: '', website: '', email: '', blog: '', reddit: '', slack: '', facebook: '', twitter: '', bitcointalk: '', github: '', telegram: '', wechat: '', linkedin: '', discord: '', whitepaper: '', tokenPriceUSD: '0' }]);
      }
      return err('Unknown action: ' + q.action);
    }

    return err(`Unknown module: ${q.module}`);
  });

  // POST /api — used by hardhat-verify and forge verify-contract
  // These tools POST form data to /api?module=contract&action=verifysourcecode
  app.post('/api', async (request) => {
    // Merge query string and body params (Hardhat sends action in query, data in body)
    const q = request.query as Record<string, string>;
    const body = (request.body || {}) as Record<string, string>;
    const params = { ...body, ...q };
    const module = (params.module || '').toLowerCase();
    const action = (params.action || '').toLowerCase();

    if (module === 'contract' && action === 'verifysourcecode') {
      return handleVerifySourceCode(params);
    }
    if (module === 'contract' && action === 'checkverifystatus') {
      return handleCheckVerifyStatus(params);
    }

    return err(`Unsupported POST action: module=${module}&action=${action}`);
  });
}

// ---------------------------------------------------------------------------
// account handlers
// ---------------------------------------------------------------------------

async function handleTxList(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const pool = getReadPool();
  const startBlock = q.startblock || '0';
  const endBlock = q.endblock || '99999999';
  const page = parseNumber(q.page, 1);
  const offset = clamp(parseNumber(q.offset, 10), 1, 10000);
  const order = parseOrder(q.sort);
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const skip = (page - 1) * offset;

  const result = await pool.query(
    `SELECT t.hash, t.block_height, b.timestamp_ms,
            t.from_address, t.to_address, t.value, t.status,
            t.gas_limit, t.gas_price, t.nonce, t.type,
            COALESCE(r.gas_used, t.gas_limit) AS gas_used
     FROM transactions t
     LEFT JOIN blocks b ON b.height = t.block_height
     LEFT JOIN LATERAL (
       SELECT gas_used FROM transactions WHERE hash = t.hash LIMIT 1
     ) r ON true
     WHERE (t.from_address = $1 OR t.to_address = $1)
       AND t.block_height::bigint >= $2::bigint
       AND t.block_height::bigint <= $3::bigint
     ORDER BY t.block_height ${direction}, t.tx_index ${direction}
     LIMIT $4 OFFSET $5`,
    [address.toLowerCase(), startBlock, endBlock, offset, skip]
  );

  const rows = result.rows.map((r: Record<string, unknown>) => ({
    blockNumber: String(r.block_height ?? ''),
    timeStamp: r.timestamp_ms ? String(Math.floor(Number(r.timestamp_ms) / 1000)) : '0',
    hash: r.hash,
    from: r.from_address,
    to: r.to_address ?? '',
    value: String(r.value ?? '0'),
    gas: String(r.gas_limit ?? '0'),
    gasPrice: String(r.gas_price ?? '0'),
    gasUsed: String(r.gas_used ?? '0'),
    nonce: String(r.nonce ?? '0'),
    transactionIndex: '0',
    txreceipt_status: r.status === '1' ? '1' : '0',
    isError: r.status === '1' ? '0' : '1',
    contractAddress: '',
    input: '',
    confirmations: '',
  }));

  return ok(rows);
}

async function handleTokenTx(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const pool = getReadPool();
  const startBlock = q.startblock || '0';
  const endBlock = q.endblock || '99999999';
  const page = parseNumber(q.page, 1);
  const offset = clamp(parseNumber(q.offset, 10), 1, 10000);
  const order = parseOrder(q.sort);
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const skip = (page - 1) * offset;

  const result = await pool.query(
    `SELECT tt.tx_hash, tt.block_height, b.timestamp_ms,
            tt.from_address, tt.to_address, tt.value, tt.token_address,
            t.name AS token_name, t.symbol AS token_symbol, t.decimals AS token_decimals
     FROM token_transfers tt
     LEFT JOIN tokens t ON t.address = tt.token_address
     LEFT JOIN blocks b ON b.height = tt.block_height
     WHERE (tt.from_address = $1 OR tt.to_address = $1)
       AND tt.block_height::bigint >= $2::bigint
       AND tt.block_height::bigint <= $3::bigint
     ORDER BY tt.block_height ${direction}, tt.log_index ${direction}
     LIMIT $4 OFFSET $5`,
    [address.toLowerCase(), startBlock, endBlock, offset, skip]
  );

  const rows = result.rows.map((r: Record<string, unknown>) => ({
    blockNumber: String(r.block_height ?? ''),
    timeStamp: r.timestamp_ms ? String(Math.floor(Number(r.timestamp_ms) / 1000)) : '0',
    hash: r.tx_hash,
    from: r.from_address,
    to: r.to_address ?? '',
    value: String(r.value ?? '0'),
    tokenName: r.token_name ?? '',
    tokenSymbol: r.token_symbol ?? '',
    tokenDecimal: String(r.token_decimals ?? '18'),
    contractAddress: r.token_address ?? '',
    transactionIndex: '0',
    gas: '0',
    gasPrice: '0',
    gasUsed: '0',
    nonce: '',
    confirmations: '',
  }));

  return ok(rows);
}

async function handleBalance(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const pool = getReadPool();
  const result = await pool.query(
    'SELECT balance FROM accounts WHERE address = $1 LIMIT 1',
    [address.toLowerCase()]
  );

  const balance = result.rows[0]?.balance ?? '0';
  return ok(String(balance));
}

async function handleBalanceMulti(q: Record<string, string>): Promise<EtherscanResponse> {
  const addressParam = q.address;
  if (!addressParam) return err('Missing address parameter');

  const addresses = addressParam.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (addresses.length === 0) return err('No valid addresses provided');
  if (addresses.length > 20) return err('Maximum 20 addresses per request');

  const pool = getReadPool();
  const placeholders = addresses.map((_, i) => `$${i + 1}`).join(',');
  const result = await pool.query(
    `SELECT address, balance FROM accounts WHERE address IN (${placeholders})`,
    addresses
  );

  const balanceMap = new Map<string, string>();
  for (const row of result.rows) {
    balanceMap.set(row.address, String(row.balance));
  }

  const rows = addresses.map((addr) => ({
    account: addr,
    balance: balanceMap.get(addr) ?? '0',
  }));

  return ok(rows);
}

async function handleTokenBalance(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');
  const contractaddress = q.contractaddress;
  if (!contractaddress) return err('Missing contractaddress parameter');

  const pool = getReadPool();
  const result = await pool.query(
    'SELECT balance FROM token_balances WHERE holder_address = $1 AND token_address = $2 LIMIT 1',
    [address.toLowerCase(), contractaddress.toLowerCase()]
  );

  const balance = result.rows[0]?.balance ?? '0';
  return ok(String(balance));
}

async function handleGetMinedBlocks(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const page = parseNumber(q.page, 1);
  const offset = clamp(parseNumber(q.offset, 10), 1, 10000);
  const skip = (page - 1) * offset;

  const pool = getReadPool();
  const result = await pool.query(
    `SELECT height AS blockNumber, timestamp_ms, tx_count AS blockReward
     FROM blocks
     WHERE producer = $1
     ORDER BY height DESC
     LIMIT $2 OFFSET $3`,
    [address.toLowerCase(), offset, skip]
  );

  const rows = result.rows.map((r: Record<string, unknown>) => ({
    blockNumber: String(r.blocknumber ?? ''),
    timeStamp: r.timestamp_ms ? String(Math.floor(Number(r.timestamp_ms) / 1000)) : '0',
    blockReward: String(r.blockreward ?? '0'),
  }));

  return ok(rows);
}

// ---------------------------------------------------------------------------
// logs handlers
// ---------------------------------------------------------------------------

async function handleGetLogs(q: Record<string, string>): Promise<EtherscanResponse> {
  const fromBlock = q.fromblock || '0';
  const toBlock = q.toblock || '99999999';

  const clauses: string[] = [
    'e.block_height::bigint >= $1::bigint',
    'e.block_height::bigint <= $2::bigint',
  ];
  const params: (string | number)[] = [fromBlock, toBlock];
  let paramIndex = 3;

  if (q.address) {
    clauses.push(`e.address = $${paramIndex}`);
    params.push(q.address.toLowerCase());
    paramIndex++;
  }
  if (q.topic0) {
    clauses.push(`e.topic0 = $${paramIndex}`);
    params.push(q.topic0.toLowerCase());
    paramIndex++;
  }
  if (q.topic1) {
    clauses.push(`e.topic1 = $${paramIndex}`);
    params.push(q.topic1.toLowerCase());
    paramIndex++;
  }

  const pool = getReadPool();
  const result = await pool.query(
    `SELECT e.address, e.topic0, e.topic1, e.topic2, e.topic3,
            e.data, e.block_height, e.tx_hash, e.log_index,
            b.timestamp_ms, e.tx_index
     FROM events e
     LEFT JOIN blocks b ON b.height = e.block_height
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.block_height ASC, e.log_index ASC
     LIMIT 1000`,
    params
  );

  const rows = result.rows.map((r: Record<string, unknown>) => {
    const topics: string[] = [];
    if (r.topic0) topics.push(String(r.topic0));
    if (r.topic1) topics.push(String(r.topic1));
    if (r.topic2) topics.push(String(r.topic2));
    if (r.topic3) topics.push(String(r.topic3));
    return {
      address: r.address,
      topics,
      data: r.data ?? '0x',
      blockNumber: r.block_height ? '0x' + BigInt(r.block_height as string).toString(16) : '0x0',
      timeStamp: r.timestamp_ms ? '0x' + Math.floor(Number(r.timestamp_ms) / 1000).toString(16) : '0x0',
      gasPrice: '0x0',
      gasUsed: '0x0',
      logIndex: r.log_index != null ? '0x' + Number(r.log_index).toString(16) : '0x0',
      transactionHash: r.tx_hash ?? '',
      transactionIndex: r.tx_index != null ? '0x' + Number(r.tx_index).toString(16) : '0x0',
    };
  });

  return ok(rows);
}

// ---------------------------------------------------------------------------
// stats handlers
// ---------------------------------------------------------------------------

async function handleEthSupply(): Promise<EtherscanResponse> {
  // Try RPC eth_getBalance on the zero address or use a known total supply method.
  // For QFC, query the sum of all account balances as an approximation,
  // or use the RPC if available.
  const supply = await rpcCallSafe<string>('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest']);
  if (supply !== null) {
    // Some chains store total supply info differently; return raw wei string
    return ok(String(BigInt(supply)));
  }

  // Fallback: sum of all account balances
  const pool = getReadPool();
  const result = await pool.query('SELECT COALESCE(SUM(balance::numeric), 0) AS total FROM accounts');
  return ok(String(result.rows[0]?.total ?? '0'));
}

async function handleEthPrice(): Promise<EtherscanResponse> {
  // QFC has no price oracle — return the expected Etherscan structure with zeroed values
  return ok({
    ethbtc: '0',
    ethbtc_timestamp: String(Math.floor(Date.now() / 1000)),
    ethusd: '0',
    ethusd_timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

// ---------------------------------------------------------------------------
// contract handlers
// ---------------------------------------------------------------------------

async function handleGetAbi(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const pool = getReadPool();
  const result = await pool.query(
    'SELECT abi, is_verified FROM contracts WHERE address = $1 LIMIT 1',
    [address.toLowerCase()]
  );

  const row = result.rows[0];
  if (!row) return err('Contract not found');
  if (!row.is_verified) return err('Contract source code not verified');
  if (!row.abi) return err('ABI not available');

  // abi is stored as JSON in the DB — return as string (Etherscan convention)
  const abiStr = typeof row.abi === 'string' ? row.abi : JSON.stringify(row.abi);
  return ok(abiStr);
}

async function handleGetSourceCode(q: Record<string, string>): Promise<EtherscanResponse> {
  const address = q.address;
  if (!address) return err('Missing address parameter');

  const pool = getReadPool();
  const result = await pool.query(
    `SELECT c.address, c.is_verified, c.abi, c.source_code,
            c.compiler_version, c.optimization_used, c.optimization_runs,
            c.evm_version, c.contract_name, c.constructor_args
     FROM contracts c WHERE c.address = $1 LIMIT 1`,
    [address.toLowerCase()]
  );

  const row = result.rows[0];
  if (!row) return err('Contract not found');
  if (!row.is_verified) return err('Contract source code not verified');

  const abiStr = row.abi ? (typeof row.abi === 'string' ? row.abi : JSON.stringify(row.abi)) : '';

  const sourceResult = [{
    SourceCode: row.source_code ?? '',
    ABI: abiStr,
    ContractName: row.contract_name ?? '',
    CompilerVersion: row.compiler_version ?? '',
    OptimizationUsed: row.optimization_used ? '1' : '0',
    Runs: String(row.optimization_runs ?? '200'),
    ConstructorArguments: row.constructor_args ?? '',
    EVMVersion: row.evm_version ?? 'paris',
    Library: '',
    LicenseType: '',
    Proxy: '0',
    Implementation: '',
    SwarmSource: '',
  }];

  return ok(sourceResult);
}

// ---------------------------------------------------------------------------
// contract verification handlers (Hardhat / Foundry compatible)
// ---------------------------------------------------------------------------

/**
 * Strip CBOR metadata suffix from deployed bytecode for comparison.
 * The last 2 bytes encode the metadata length; we remove that many bytes.
 */
function stripCborMetadata(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 4) return clean;
  const metaLen = parseInt(clean.slice(-4), 16) * 2 + 4;
  return metaLen < clean.length ? clean.slice(0, clean.length - metaLen) : clean;
}

/**
 * POST module=contract&action=verifysourcecode
 *
 * Etherscan-compatible verification used by:
 *   - hardhat-verify (`npx hardhat verify`)
 *   - forge verify-contract (`forge verify-contract`)
 *
 * Accepts both `solidity-single-file` and `solidity-standard-json-input` formats.
 */
async function handleVerifySourceCode(params: Record<string, string>): Promise<EtherscanResponse> {
  const address = params.contractaddress;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return err('Missing or invalid contractaddress');
  }

  const sourceCode = params.sourceCode || params.sourcecode || '';
  if (!sourceCode) return err('Missing sourceCode');

  const compilerVersion = params.compilerversion || '';
  if (!compilerVersion) return err('Missing compilerversion');

  const codeFormat = (params.codeformat || 'solidity-single-file').toLowerCase();
  const contractName = params.contractname || '';   // e.g. "contracts/Foo.sol:Foo"
  const optimizationUsed = params.optimizationUsed || params.optimizationused || '0';
  const runs = parseInt(params.runs || '200', 10);
  const constructorArgs = params.constructorArguements || params.constructorarguments || '';
  // QFC does NOT support PUSH0 — always force paris
  const evmVersion = 'paris';

  // Fetch deployed bytecode from chain
  const deployedCode = await rpcCallSafe<string>('eth_getCode', [address, 'latest']);
  if (!deployedCode || deployedCode === '0x') {
    return err('No contract code found at this address');
  }

  try {
    const solc = await import(/* webpackIgnore: true */ 'solc' as string) as { compile: (input: string) => string };
    let solcInput: string;

    if (codeFormat === 'solidity-standard-json-input') {
      // sourceCode is the full Standard JSON Input string
      let jsonInput: { language: string; sources: Record<string, unknown>; settings?: Record<string, unknown> };
      try {
        jsonInput = JSON.parse(sourceCode);
      } catch {
        return err('Invalid Standard JSON Input');
      }

      // Ensure required output selection and force evmVersion
      if (!jsonInput.settings) jsonInput.settings = {};
      jsonInput.settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } };
      jsonInput.settings.evmVersion = evmVersion;

      solcInput = JSON.stringify(jsonInput);
    } else {
      // solidity-single-file: sourceCode is raw Solidity
      const optimizerSettings = optimizationUsed === '1'
        ? { enabled: true, runs }
        : { enabled: false };

      solcInput = JSON.stringify({
        language: 'Solidity',
        sources: { 'contract.sol': { content: sourceCode } },
        settings: {
          evmVersion,
          optimizer: optimizerSettings,
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
        },
      });
    }

    const output = JSON.parse(solc.compile(solcInput));
    if (output.errors?.some((e: { severity: string }) => e.severity === 'error')) {
      const msgs = output.errors
        .filter((e: { severity: string }) => e.severity === 'error')
        .map((e: { formattedMessage?: string; message: string }) => e.formattedMessage || e.message);
      return err(`Compilation failed: ${msgs.join('; ')}`);
    }

    const deployedStripped = stripCborMetadata(deployedCode);

    // If contractname is "path/File.sol:ContractName", try that specific contract first
    let targetFile: string | undefined;
    let targetContract: string | undefined;
    if (contractName.includes(':')) {
      const parts = contractName.split(':');
      targetContract = parts.pop()!;
      targetFile = parts.join(':');
    } else if (contractName) {
      targetContract = contractName;
    }

    // Search all compiled contracts for a bytecode match
    for (const [fileName, fileContracts] of Object.entries(output.contracts || {})) {
      for (const [name, contractData] of Object.entries(fileContracts as Record<string, unknown>)) {
        // If a target was specified, skip non-matching entries
        if (targetContract && name !== targetContract) continue;
        if (targetFile && fileName !== targetFile) continue;

        const data = contractData as { evm: { deployedBytecode: { object: string } }; abi: unknown[] };
        const compiledBytecode = data.evm.deployedBytecode.object;
        const abi = data.abi;

        const compiledStripped = stripCborMetadata(compiledBytecode);

        if (deployedStripped === compiledStripped) {
          // Match found — persist to DB
          const pool = getPool();
          const fullContractName = `${fileName}:${name}`;

          await pool.query(
            `UPDATE contracts SET
               source_code = $2, abi = $3, compiler_version = $4,
               evm_version = $5, optimization_runs = $6,
               is_verified = true, verified_at = NOW(),
               contract_name = $7, constructor_args = $8,
               optimization_used = $9
             WHERE address = $1`,
            [
              address.toLowerCase(),
              sourceCode,
              JSON.stringify(abi),
              compilerVersion,
              evmVersion,
              optimizationUsed === '1' ? runs : null,
              fullContractName,
              constructorArgs || null,
              optimizationUsed === '1',
            ]
          );

          // Return GUID — Etherscan returns a GUID that is later polled.
          // We do verification synchronously, so use the address as the GUID.
          return ok(address.toLowerCase());
        }
      }
    }

    // If we targeted a specific contract but didn't find it, retry without filter
    if (targetContract) {
      for (const [fileName, fileContracts] of Object.entries(output.contracts || {})) {
        for (const [name, contractData] of Object.entries(fileContracts as Record<string, unknown>)) {
          const data = contractData as { evm: { deployedBytecode: { object: string } }; abi: unknown[] };
          const compiledStripped = stripCborMetadata(data.evm.deployedBytecode.object);
          if (deployedStripped === compiledStripped) {
            const pool = getPool();
            const fullContractName = `${fileName}:${name}`;
            await pool.query(
              `UPDATE contracts SET
                 source_code = $2, abi = $3, compiler_version = $4,
                 evm_version = $5, optimization_runs = $6,
                 is_verified = true, verified_at = NOW(),
                 contract_name = $7, constructor_args = $8,
                 optimization_used = $9
               WHERE address = $1`,
              [
                address.toLowerCase(),
                sourceCode,
                JSON.stringify(data.abi),
                compilerVersion,
                evmVersion,
                optimizationUsed === '1' ? runs : null,
                fullContractName,
                constructorArgs || null,
                optimizationUsed === '1',
              ]
            );
            return ok(address.toLowerCase());
          }
        }
      }
    }

    return err('Bytecode mismatch — verification failed');
  } catch (error) {
    return err(error instanceof Error ? error.message : 'Verification failed');
  }
}

/**
 * GET/POST module=contract&action=checkverifystatus
 *
 * Polled by hardhat-verify / forge after submitting verification.
 * The guid is the contract address (we verify synchronously).
 */
async function handleCheckVerifyStatus(params: Record<string, string>): Promise<EtherscanResponse> {
  const guid = params.guid;
  if (!guid) return err('Missing guid parameter');

  // The guid is the contract address (returned by verifysourcecode)
  const address = guid.toLowerCase();
  const pool = getReadPool();
  const result = await pool.query(
    'SELECT is_verified FROM contracts WHERE address = $1 LIMIT 1',
    [address]
  );

  const row = result.rows[0];
  if (!row) return err('Contract not found');
  if (row.is_verified) {
    return ok('Pass - Verified');
  }
  return err('Fail - Unable to verify');
}

// ---------------------------------------------------------------------------
// proxy handlers (RPC passthrough)
// ---------------------------------------------------------------------------

async function handleEthBlockNumber(): Promise<EtherscanResponse> {
  const blockNumber = await rpcCallSafe<string>('eth_blockNumber', []);
  if (blockNumber === null) return err('RPC call failed');
  // Etherscan proxy endpoints return the raw JSON-RPC result
  return { status: '1', message: 'OK', result: blockNumber };
}

async function handleEthGetBlockByNumber(q: Record<string, string>): Promise<EtherscanResponse> {
  const tag = q.tag || 'latest';
  const booleanStr = q.boolean || 'true';
  const full = booleanStr === 'true';

  const block = await rpcCallSafe<unknown>('eth_getBlockByNumber', [tag, full]);
  if (block === null) return err('RPC call failed');
  return { status: '1', message: 'OK', result: block };
}
