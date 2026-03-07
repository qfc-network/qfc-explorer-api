export type RpcBlock = {
  number: string;
  hash: string;
  parentHash: string;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  miner: string;
  timestamp: string;
  gasLimit: string;
  gasUsed: string;
  extraData: string;
  transactions?: RpcTransaction[];
  transactionHashes?: string[];
};

export type RpcTransaction = {
  hash: string;
  nonce: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  transactionIndex?: string | null;
  from: string;
  to?: string | null;
  value: string;
  gas: string;
  gasPrice: string;
  input: string;
};

export type RpcReceipt = {
  transactionHash: string;
  transactionIndex: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  from: string;
  to?: string | null;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress?: string | null;
  logs: RpcLog[];
  logsBloom: string;
  status: string;
};

export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | null;
  blockHash?: string | null;
  transactionHash?: string | null;
  transactionIndex?: string | null;
  logIndex?: string | null;
};

// debug_traceTransaction callTracer result
export type TraceCall = {
  type: string;       // CALL, STATICCALL, DELEGATECALL, CREATE, CREATE2, SELFDESTRUCT
  from: string;
  to?: string;
  value?: string;     // hex
  gas?: string;       // hex
  gasUsed?: string;   // hex
  input?: string;
  output?: string;
  error?: string;
  calls?: TraceCall[];
};
