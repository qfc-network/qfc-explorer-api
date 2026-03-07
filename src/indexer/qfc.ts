import { RpcClient } from './rpc.js';

export type RpcValidator = {
  address: string;
  stake: string;
  contributionScore: string;
  uptime: string;
  isActive: boolean;
  providesCompute: boolean;
  hashrate: string;
  inferenceScore: string;
  computeMode: string;
  tasksCompleted: string;
};

export type RpcEpoch = {
  number: string;
  startTime: string;
  durationMs: string;
};

export type RpcNodeInfo = {
  version: string;
  chainId: string;
  peerCount: number;
  isValidator: boolean;
  syncing: boolean;
};

export async function fetchValidators(client: RpcClient): Promise<RpcValidator[]> {
  return client.callWithRetry<RpcValidator[]>('qfc_getValidators');
}

export async function fetchEpoch(client: RpcClient): Promise<RpcEpoch> {
  return client.callWithRetry<RpcEpoch>('qfc_getEpoch');
}

export async function fetchNodeInfo(client: RpcClient): Promise<RpcNodeInfo> {
  return client.callWithRetry<RpcNodeInfo>('qfc_nodeInfo');
}

// v2.0: AI Inference types

export type RpcInferenceStats = {
  tasksCompleted: string;
  avgTimeMs: string;
  flopsTotal: string;
  passRate: string;
};

export type RpcComputeInfo = {
  backend: string;
  supportedModels: string[];
  gpuMemoryMb: number;
  inferenceScore: string;
  gpuTier: string;
  providesCompute: boolean;
};

export async function fetchInferenceStats(client: RpcClient): Promise<RpcInferenceStats> {
  return client.callWithRetry<RpcInferenceStats>('qfc_getInferenceStats');
}

export async function fetchComputeInfo(client: RpcClient): Promise<RpcComputeInfo> {
  return client.callWithRetry<RpcComputeInfo>('qfc_getComputeInfo');
}

// v2.0: Model governance types

export type RpcModel = {
  name: string;
  version: string;
  minMemoryMb: number;
  minTier: string;
  approved: boolean;
};

export type RpcModelProposal = {
  proposalId: string;
  proposer: string;
  modelName: string;
  modelVersion: string;
  description: string;
  minMemoryMb: number;
  minTier: string;
  sizeMb: number;
  votesFor: number;
  votesAgainst: number;
  status: string;
  createdAt: number;
  votingDeadline: number;
};

export async function fetchSupportedModels(client: RpcClient): Promise<RpcModel[]> {
  return client.callWithRetry<RpcModel[]>('qfc_getSupportedModels');
}

// v2.0: Public inference task lookup

export type RpcPublicTaskStatus = {
  taskId: string;
  status: string;
  submitter: string;
  taskType: string;
  modelId: string;
  createdAt: number;
  deadline: number;
  maxFee: string;
  result?: string;
  resultSize?: number;
  minerAddress?: string;
  executionTimeMs?: number;
};

export async function fetchPublicTaskStatus(
  client: RpcClient,
  taskId: string,
): Promise<RpcPublicTaskStatus> {
  return client.callWithRetry<RpcPublicTaskStatus>('qfc_getPublicTaskStatus', [taskId]);
}

export async function fetchModelProposals(client: RpcClient): Promise<RpcModelProposal[]> {
  return client.callWithRetry<RpcModelProposal[]>('qfc_getModelProposals');
}
