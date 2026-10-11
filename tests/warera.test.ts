import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarEraClient, WarEraError, countryListSchema } from '../worker/warera';

afterEach(() => vi.restoreAllMocks());

describe('WarEraClient', () => {
  it('encodes tRPC input and validates the response envelope', async () => {
    const fetcher = vi.fn(async (_url: string) => Response.json({ result: { data: [{ _id: 'a', name: 'Spain' }] } }, { headers: { 'ratelimit-remaining': '99', 'ratelimit-reset': '60' } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    expect(await client.get('country.getAllCountries', { limit: 2 }, countryListSchema)).toHaveLength(1);
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ limit: 2 });
    expect(url.pathname).toBe('/trpc/country.getAllCountries');
  });

  it('rejects malformed records and never retries schema failures', async () => {
    const fetcher = vi.fn(async () => Response.json({ result: { data: [{ _id: 'a' }] } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.get('country.getAllCountries', undefined, countryListSchema)).rejects.toThrow('schema validation');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops on an upstream rate limit with a retry window', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'rate limit' }, { status: 429, headers: { 'retry-after': '25', 'ratelimit-remaining': '0' } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.get('country.getAllCountries', undefined, countryListSchema)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 25 } satisfies Partial<WarEraError>);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
