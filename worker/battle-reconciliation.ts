import { z } from 'zod';
import type { Env } from './types';
import { WarEraClient, WarEraError } from './warera';

const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const detailSchema = z.object({ _id: z.string().regex(idPattern), isActive: z.boolean(), endedAt: z.string().nullish(),
  wonBy: z.unknown().optional(), attacker: z.unknown().optional(), defender: z.unknown().optional(),
  type: z.unknown().optional(), createdAt: z.unknown().optional(), currentRound: z.unknown().optional() });
type Candidate = { id: string; updated_at: string };
export type BattleReconciliationBatch = { records: unknown[]; next: null; delay: number; sourceUrl?: string; checkpoint?: D1PreparedStatement };
const smallObject = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return { country: typeof row.country === 'string' && idPattern.test(row.country) ? row.country : null,
    region: typeof row.region === 'string' && idPattern.test(row.region) ? row.region : null,
    damages: typeof row.damages === 'number' && Number.isFinite(row.damages) && row.damages >= 0 ? row.damages : null };
};

/** Recheck one already-known active battle. A missing detail is unknown, never a confirmed end. */
export async function fetchBattleReconciliation(env: Env, client: WarEraClient, limit = 1,
  now = new Date()): Promise<BattleReconciliationBatch> {
  if (!Number.isInteger(limit) || limit !== 1) throw new Error('Battle reconciliation limit must be 1');
  const checkedAt = now.toISOString();
  const retryBefore = new Date(now.getTime() - 10 * 60_000).toISOString();
  const battle = await env.DB.prepare(`SELECT b.id,b.updated_at FROM battles b
    LEFT JOIN battle_reconciliation_state s ON s.battle_id=b.id
    WHERE b.is_active=1 AND (s.last_checked_at IS NULL OR s.last_checked_at<=?)
    ORDER BY COALESCE(s.last_checked_at,''),b.updated_at,b.id LIMIT 1`).bind(retryBefore).first<Candidate>();
  if (!battle) return { records: [], next: null, delay: 600 };
  if (!idPattern.test(battle.id)) throw new Error('Invalid stored battle ID');
  const url = client.url('battle.getById', { battleId: battle.id });
  const checkpoint = (status: string) => env.DB.prepare(`INSERT INTO battle_reconciliation_state(battle_id,last_checked_at,last_status)
    VALUES(?,?,?) ON CONFLICT(battle_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_status=excluded.last_status`)
    .bind(battle.id, checkedAt, status);
  let detail: z.infer<typeof detailSchema>;
  try { detail = await client.get('battle.getById', { battleId: battle.id }, detailSchema); }
  catch (error) {
    if (error instanceof WarEraError && error.status === 404) return { records: [], next: null, delay: 600,
      sourceUrl: url, checkpoint: checkpoint('not-found-unknown') };
    throw error;
  }
  if (detail._id !== battle.id) throw new Error('Battle detail ID mismatch');
  if (detail.endedAt != null && !Number.isFinite(Date.parse(detail.endedAt))) throw new Error('Battle detail has invalid end time');
  const record = { _id: detail._id, isActive: detail.isActive, endedAt: detail.endedAt ?? null,
    wonBy: typeof detail.wonBy === 'string' ? detail.wonBy.slice(0, 100) : null,
    attacker: smallObject(detail.attacker), defender: smallObject(detail.defender),
    type: typeof detail.type === 'string' ? detail.type.slice(0, 100) : null,
    createdAt: typeof detail.createdAt === 'string' ? detail.createdAt.slice(0, 80) : null,
    currentRound: typeof detail.currentRound === 'number' && Number.isFinite(detail.currentRound) ? detail.currentRound : null };
  return { records: [record], next: null, delay: 600, sourceUrl: url,
    checkpoint: checkpoint(detail.isActive ? 'verified-active' : 'verified-inactive') };
}
