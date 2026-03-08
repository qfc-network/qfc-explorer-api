import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  getNote,
  getNotes,
  upsertNote,
  deleteNote,
  getNotesForTargets,
} from '../db/notes-queries.js';

const VALID_TARGET_TYPES = ['address', 'transaction'];
const MAX_NOTE_LENGTH = 500;
const TARGET_ID_RE = /^0x[0-9a-fA-F]+$/;

export default async function notesRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', requireAuth);

  // GET /notes — list all user notes, optional ?type=address|transaction filter
  app.get('/', async (request, _reply) => {
    const userId = request.user!.userId;
    const { type } = request.query as { type?: string };

    const targetType = type && VALID_TARGET_TYPES.includes(type) ? type : undefined;
    const notes = await getNotes(userId, targetType);

    return { ok: true, data: { notes } };
  });

  // GET /notes/:targetType/:targetId — get note for specific target
  app.get('/:targetType/:targetId', async (request, reply) => {
    const userId = request.user!.userId;
    const { targetType, targetId } = request.params as { targetType: string; targetId: string };

    if (!VALID_TARGET_TYPES.includes(targetType)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target type. Must be "address" or "transaction".' };
    }

    if (!TARGET_ID_RE.test(targetId)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target ID format.' };
    }

    const note = await getNote(userId, targetType, targetId);
    return { ok: true, data: { note } };
  });

  // PUT /notes/:targetType/:targetId — upsert note
  app.put('/:targetType/:targetId', async (request, reply) => {
    const userId = request.user!.userId;
    const { targetType, targetId } = request.params as { targetType: string; targetId: string };
    const body = request.body as { note?: string };

    if (!VALID_TARGET_TYPES.includes(targetType)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target type. Must be "address" or "transaction".' };
    }

    if (!TARGET_ID_RE.test(targetId)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target ID format.' };
    }

    if (!body.note || typeof body.note !== 'string' || body.note.trim().length === 0) {
      reply.status(400);
      return { ok: false, error: 'Note text is required.' };
    }

    const noteText = body.note.trim();
    if (noteText.length > MAX_NOTE_LENGTH) {
      reply.status(400);
      return { ok: false, error: `Note must be ${MAX_NOTE_LENGTH} characters or less.` };
    }

    const note = await upsertNote(userId, targetType, targetId, noteText);
    return { ok: true, data: { note } };
  });

  // DELETE /notes/:targetType/:targetId — delete note
  app.delete('/:targetType/:targetId', async (request, reply) => {
    const userId = request.user!.userId;
    const { targetType, targetId } = request.params as { targetType: string; targetId: string };

    if (!VALID_TARGET_TYPES.includes(targetType)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target type. Must be "address" or "transaction".' };
    }

    if (!TARGET_ID_RE.test(targetId)) {
      reply.status(400);
      return { ok: false, error: 'Invalid target ID format.' };
    }

    const removed = await deleteNote(userId, targetType, targetId);
    if (!removed) {
      reply.status(404);
      return { ok: false, error: 'Note not found.' };
    }

    return { ok: true, data: { deleted: true } };
  });

  // POST /notes/batch — batch get notes for multiple targets
  app.post('/batch', async (request, reply) => {
    const userId = request.user!.userId;
    const body = request.body as { targets?: Array<{ type: string; id: string }> };

    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      reply.status(400);
      return { ok: false, error: 'targets array is required.' };
    }

    if (body.targets.length > 100) {
      reply.status(400);
      return { ok: false, error: 'Maximum 100 targets per batch request.' };
    }

    // Group targets by type
    const byType = new Map<string, string[]>();
    for (const target of body.targets) {
      if (!VALID_TARGET_TYPES.includes(target.type) || !TARGET_ID_RE.test(target.id)) {
        continue;
      }
      const ids = byType.get(target.type) || [];
      ids.push(target.id);
      byType.set(target.type, ids);
    }

    // Fetch notes for each type
    const result: Record<string, Record<string, string>> = {};
    for (const [type, ids] of byType) {
      const notesMap = await getNotesForTargets(userId, type, ids);
      result[type] = Object.fromEntries(notesMap);
    }

    return { ok: true, data: { notes: result } };
  });
}
