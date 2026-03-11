import { FastifyInstance } from 'fastify';
import { rpcCallSafe } from '../lib/rpc.js';
import { cached } from '../lib/cache.js';
import { parseNumber, clamp } from '../lib/pagination.js';

type TaskItem = Record<string, unknown>;
type ModelItem = { name: string; version: string; minMemoryMb: number; minTier: string; approved: boolean };

export default async function inferenceRoutes(app: FastifyInstance) {
  // GET /inference
  app.get('/', async () => {
    const [stats, computeInfo, validators, models] = await Promise.all([
      rpcCallSafe<Record<string, unknown>>('qfc_getInferenceStats', []),
      rpcCallSafe<Record<string, unknown>>('qfc_getComputeInfo', []),
      rpcCallSafe<Array<Record<string, unknown>>>('qfc_getValidators', []),
      rpcCallSafe<Array<ModelItem>>('qfc_getSupportedModels', []),
    ]);
    return { ok: true, data: { stats, computeInfo, validators, models } };
  });

  // GET /inference/task
  app.get('/task', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (!q.id) {
      reply.status(400);
      return { ok: false, error: 'Missing task id' };
    }
    const task = await rpcCallSafe<Record<string, unknown>>('qfc_getPublicTaskStatus', [q.id]);
    if (!task) {
      reply.status(404);
      return { ok: false, error: 'Task not found' };
    }
    return { ok: true, data: task };
  });

  // GET /inference/tasks — paginated task list with stats
  app.get('/tasks', async (request) => {
    const q = request.query as Record<string, string>;
    const page = parseNumber(q.page, 1);
    const limit = clamp(parseNumber(q.limit, 25), 1, 100);
    const statusFilter = q.status || null;
    const submitter = q.submitter?.toLowerCase() || null;

    const data = await cached(`inference:tasks:${page}:${limit}:${statusFilter}:${submitter}`, 10, async () => {
      // Fetch all tasks from RPC
      const allTasks = await rpcCallSafe<TaskItem[]>('qfc_getInferenceTasks', []) ?? [];

      // Filter
      let filtered = allTasks;
      if (statusFilter) {
        filtered = filtered.filter((t) => String(t.status).toLowerCase() === statusFilter.toLowerCase());
      }
      if (submitter) {
        filtered = filtered.filter((t) => String(t.submitter).toLowerCase() === submitter);
      }

      // Sort by createdAt descending
      filtered.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));

      // Stats
      const completed = allTasks.filter((t) => String(t.status).toLowerCase() === 'completed').length;
      const pending = allTasks.filter((t) => String(t.status).toLowerCase() === 'pending').length;
      const failed = allTasks.filter((t) => String(t.status).toLowerCase() === 'failed').length;
      const completedTasks = allTasks.filter((t) => t.executionTimeMs && Number(t.executionTimeMs) > 0);
      const avgExecTime = completedTasks.length > 0
        ? Math.round(completedTasks.reduce((sum, t) => sum + Number(t.executionTimeMs), 0) / completedTasks.length)
        : 0;

      // Paginate
      const total = filtered.length;
      const start = (page - 1) * limit;
      const items = filtered.slice(start, start + limit);

      return {
        page,
        limit,
        total,
        status: statusFilter,
        stats: { total: allTasks.length, completed, pending, failed, avgExecutionTimeMs: avgExecTime },
        items,
      };
    });

    return { ok: true, data };
  });

  // GET /inference/marketplace — models with usage stats for marketplace view
  app.get('/marketplace', async () => {
    const data = await cached('inference:marketplace', 30, async () => {
      const [models, stats, allTasks, miners] = await Promise.all([
        rpcCallSafe<ModelItem[]>('qfc_getSupportedModels', []) ?? [],
        rpcCallSafe<Record<string, unknown>>('qfc_getInferenceStats', []),
        rpcCallSafe<TaskItem[]>('qfc_getInferenceTasks', []) ?? [],
        rpcCallSafe<Array<Record<string, unknown>>>('qfc_getRegisteredMiners', []) ?? [],
      ]);

      const modelList = models ?? [];
      const taskList = allTasks ?? [];
      const minerList = miners ?? [];

      // Compute per-model stats
      const modelCards = modelList.filter((m) => m.approved).map((model) => {
        const modelTasks = taskList.filter((t) => String(t.modelId) === model.name);
        const completedTasks = modelTasks.filter((t) => String(t.status).toLowerCase() === 'completed');
        const failedTasks = modelTasks.filter((t) => String(t.status).toLowerCase() === 'failed');
        const avgExecTime = completedTasks.length > 0
          ? Math.round(completedTasks.reduce((sum, t) => sum + Number(t.executionTimeMs ?? 0), 0) / completedTasks.length)
          : 0;

        // Count miners that support this model (by tier compatibility)
        const tierRank: Record<string, number> = { Cool: 1, Warm: 2, Hot: 3 };
        const minTierRank = tierRank[model.minTier] ?? 1;
        const supportingMiners = minerList.filter((m) => {
          const minerTier = Number(m.tier ?? 0);
          return minerTier >= minTierRank;
        }).length;

        // Avg fee from completed tasks
        const avgFee = completedTasks.length > 0
          ? (completedTasks.reduce((sum, t) => sum + Number(t.maxFee ?? 0), 0) / completedTasks.length).toString()
          : '0';

        return {
          name: model.name,
          version: model.version,
          minTier: model.minTier,
          minMemoryMb: model.minMemoryMb,
          totalTasks: modelTasks.length,
          completedTasks: completedTasks.length,
          failedTasks: failedTasks.length,
          successRate: modelTasks.length > 0
            ? Math.round((completedTasks.length / modelTasks.length) * 100)
            : 0,
          avgExecutionTimeMs: avgExecTime,
          activeMiners: supportingMiners,
          avgFee,
        };
      });

      // Sort by popularity (total tasks desc)
      modelCards.sort((a, b) => b.totalTasks - a.totalTasks);

      return {
        totalModels: modelCards.length,
        totalTasks: taskList.length,
        totalMiners: minerList.length,
        avgPassRate: stats ? Number((stats as Record<string, string>).passRate ?? 0) : 0,
        models: modelCards,
      };
    });

    return { ok: true, data };
  });
}
