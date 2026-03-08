import { getPool, getReadPool } from './pool.js';

// --- Types ---

export type NoteRow = {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string;
  note: string;
  created_at: string;
  updated_at: string;
};

// --- Queries ---

export async function getNote(
  userId: string,
  targetType: string,
  targetId: string
): Promise<NoteRow | null> {
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT id, user_id, target_type, target_id, note, created_at, updated_at
     FROM user_notes
     WHERE user_id = $1 AND target_type = $2 AND target_id = $3
     LIMIT 1`,
    [userId, targetType, targetId]
  );
  return result.rows[0] ?? null;
}

export async function getNotes(
  userId: string,
  targetType?: string
): Promise<NoteRow[]> {
  const pool = getReadPool();
  if (targetType) {
    const result = await pool.query(
      `SELECT id, user_id, target_type, target_id, note, created_at, updated_at
       FROM user_notes
       WHERE user_id = $1 AND target_type = $2
       ORDER BY updated_at DESC`,
      [userId, targetType]
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT id, user_id, target_type, target_id, note, created_at, updated_at
     FROM user_notes
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function upsertNote(
  userId: string,
  targetType: string,
  targetId: string,
  note: string
): Promise<NoteRow> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO user_notes (user_id, target_type, target_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, target_type, target_id)
     DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()
     RETURNING id, user_id, target_type, target_id, note, created_at, updated_at`,
    [userId, targetType, targetId, note]
  );
  return result.rows[0];
}

export async function deleteNote(
  userId: string,
  targetType: string,
  targetId: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM user_notes
     WHERE user_id = $1 AND target_type = $2 AND target_id = $3`,
    [userId, targetType, targetId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getNotesForTargets(
  userId: string,
  targetType: string,
  targetIds: string[]
): Promise<Map<string, string>> {
  if (targetIds.length === 0) return new Map();
  const pool = getReadPool();
  const result = await pool.query(
    `SELECT target_id, note
     FROM user_notes
     WHERE user_id = $1 AND target_type = $2 AND target_id = ANY($3)`,
    [userId, targetType, targetIds]
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.target_id, row.note);
  }
  return map;
}
