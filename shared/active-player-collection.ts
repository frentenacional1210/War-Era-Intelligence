import { z } from 'zod';
import type { WarEraClient } from '../worker/warera';
import { playerSchema } from '../worker/warera';
import { MAX_PROJECTED_PROFILE_BYTES, projectPlayerBatch } from './public-projection';

type Upstream = <T>(call: () => Promise<T>) => Promise<T>;
const activityPlayerSchema = playerSchema.extend({ isActive: z.boolean().nullable().optional() });
// Upstream tRPC batches keep the eight-procedure size proven in production;
// larger collector pages are split into sequential, rate-spaced batches.
export const WARERA_PROFILE_BATCH = 8;

async function profilesById(client: Pick<WarEraClient, 'getMany'>, procedure: string, ids: string[], upstream: Upstream) {
  const rows: z.infer<typeof activityPlayerSchema>[] = [];
  for (let start = 0; start < ids.length; start += WARERA_PROFILE_BATCH) {
    const part = ids.slice(start, start + WARERA_PROFILE_BATCH);
    rows.push(...await upstream(() => client.getMany(procedure, part.map(userId => ({ userId })), activityPlayerSchema)));
  }
  return rows;
}

/** Keep one compact result per candidate so the collector commit remains positionally verifiable. */
export async function collectPlayerProfiles(
  client: Pick<WarEraClient, 'getMany'>,
  ids: string[],
  upstream: Upstream,
  maximum = 8,
): Promise<Record<string, unknown>[]> {
  if (ids.length > maximum || new Set(ids).size !== ids.length) throw new Error('Collector player IDs exceed limit or repeat');
  if (!ids.length) return [];

  const lite = await profilesById(client, 'user.getUserLite', ids, upstream);
  if (lite.length !== ids.length || lite.some((row, index) => row._id !== ids[index])) throw new Error('Collector lite profile order mismatch');
  const liteProjected = projectPlayerBatch(lite, ids, maximum);

  const activeIds = ids.filter((_, index) => lite[index].isActive === true);
  const full = activeIds.length ? await profilesById(client, 'user.getUserById', activeIds, upstream) : [];
  if (full.length !== activeIds.length || full.some((row, index) => row._id !== activeIds[index])) throw new Error('Collector full profile order mismatch');

  const fullProjected = projectPlayerBatch(full, activeIds, maximum);
  const fullIndex = new Map(activeIds.map((id, index) => [id, index]));
  const profiles = ids.map((userId, index) => {
    const position = fullIndex.get(userId);
    if (position === undefined) return liteProjected[index];
    const activity = full[position].isActive;
    // The later full lookup wins when activity changed. Missing activity retains the lite proof.
    if (activity === false || activity === null) return { ...liteProjected[index], isActive: activity };
    return { ...fullProjected[position], isActive: true };
  });
  if (new TextEncoder().encode(JSON.stringify(profiles)).byteLength > MAX_PROJECTED_PROFILE_BYTES) throw new Error('Collector projected profiles exceed byte limit');
  return profiles;
}
