import { z } from 'zod';

const id = z.string().min(1).max(100);
const text = z.string().max(1000);
const timestamp = z.string().max(80).nullable();
const value = z.number().finite().nullable();
const nullableId = id.nullable().optional();

const playerRef = z.object({ _id: id });
const player = z.object({
  _id: id, username: z.string().min(1).max(300), country: nullableId,
  party: nullableId, mu: nullableId, updatedAt: timestamp.optional(),
  isActive: z.boolean().nullable().optional(),
  dates: z.object({ lastConnectionAt: timestamp.optional() }).nullish(),
  leveling: z.object({ level: value.optional(), totalXp: value.optional(), xp: value.optional() }).nullish(),
  stats: z.object({ damagesCount: value.optional() }).nullish(),
});
const articleVisibility = z.object({ _id: id, isPublic: z.boolean().nullable().optional(), isPublished: z.boolean().nullable().optional(), isDeleted: z.boolean().nullable().optional() });
const article = z.object({
  _id: id, title: text, author: nullableId, country: nullableId,
  publishedAt: timestamp.optional(), updatedAt: timestamp.optional(),
  language: z.string().max(30).nullable().optional(), category: z.string().max(100).nullable().optional(),
  slug: z.string().max(300).nullable().optional(),
  isPublic: z.boolean().nullable().optional(), isPublished: z.boolean().nullable().optional(), isDeleted: z.boolean().nullable().optional(),
  stats: z.object({ views: value.optional(), likes: value.optional(), comments: value.optional() }).nullish(),
});
const page = z.object({ items: z.array(z.unknown()), nextCursor: z.string().min(1).max(500).nullish() });

export type PublicSource = 'players' | 'articles';
export type PublicPage = { items: Record<string, unknown>[]; nextCursor: string | null };
export const MAX_PROJECTED_PROFILE_BYTES = 16_384;

/** Strip all upstream fields except those the existing normalizer reads. */
export function projectPlayerRef(input: unknown): Record<string, unknown> { return playerRef.parse(input); }
export function projectPlayer(input: unknown): Record<string, unknown> { return player.parse(input); }
/**
 * Public full-profile contract (anonymous probe, 2026-10-12):
 * POST /trpc/user.getUserById,user.getUserById?batch=1 with indexed
 * `{userId}` inputs returned ordered result envelopes (HTTP 200, two items).
 * A profile may omit party and mu; when present they are string IDs. The raw
 * response was about 10 KB for two profiles and is never logged or committed.
 * Only the field allowlist above reaches the Worker. Its unchanged collector
 * simulation exposes the compact records as user.getUserLite results so existing
 * ingestion and cursor claims remain compatible. Eight projected profiles are
 * capped at 16 KB, leaving room in the Worker's 32 KB commit body for the page.
 */
export function projectPlayerBatch(inputs: unknown[], expectedIds: string[], maximum = 8): Record<string, unknown>[] {
  if (!Array.isArray(inputs) || inputs.length !== expectedIds.length || inputs.length > maximum) throw new Error('Collector profile count mismatch');
  const profiles = inputs.map(projectPlayer);
  if (profiles.some((profile, index) => profile._id !== expectedIds[index])) throw new Error('Collector profile order mismatch');
  if (new TextEncoder().encode(JSON.stringify(profiles)).byteLength > MAX_PROJECTED_PROFILE_BYTES) throw new Error('Collector projected profiles exceed byte limit');
  return profiles;
}
export function projectArticle(input: unknown): Record<string, unknown> {
  const visibility = articleVisibility.parse(input);
  if (visibility.isPublic !== true || visibility.isPublished !== true || visibility.isDeleted === true) return { _id: visibility._id, isPublic: false };
  const row = article.parse(input);
  return row;
}
export function projectPublicPage(source: PublicSource, input: unknown, maximum: number): PublicPage {
  const parsed = page.parse(input);
  if (parsed.items.length > maximum) throw new Error('Collector page exceeds limit');
  const items = parsed.items.map(item => source === 'players' ? projectPlayerRef(item) : projectArticle(item));
  const ids = items.map(item => item._id);
  if (new Set(ids).size !== ids.length) throw new Error('Collector page repeats an ID');
  return { items, nextCursor: parsed.nextCursor ?? null };
}
