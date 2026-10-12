import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarEraClient, WarEraError, countryListSchema, playerSchema } from '../worker/warera';

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

  it('posts indexed inputs and returns validated batch results in order', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([
      { result: { data: { _id: 'b', username: 'Beta' } } },
      { result: { data: { _id: 'a', username: 'Alpha' } } },
    ], { headers: { 'ratelimit-remaining': '99' } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    expect(await client.getMany('user.getUserLite', [{ userId: 'b' }, { userId: 'a' }], playerSchema)).toEqual([
      { _id: 'b', username: 'Beta' }, { _id: 'a', username: 'Alpha' },
    ]);
    const [requestUrl, init] = fetcher.mock.calls[0]!;
    const url = new URL(requestUrl);
    expect(url.pathname).toBe('/trpc/user.getUserLite,user.getUserLite');
    expect(url.searchParams.get('batch')).toBe('1');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({ '0': { userId: 'b' }, '1': { userId: 'a' } });
  });

  it('rejects the entire batch when an item is malformed or missing', async () => {
    const fetcher = vi.fn(async () => Response.json([
      { result: { data: { _id: 'a', username: 'Alpha' } } },
      { result: { data: { _id: 'b' } } },
    ]));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.getMany('user.getUserLite', [{ userId: 'a' }, { userId: 'b' }], playerSchema)).rejects.toThrow('batch item 1 response failed schema validation');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(Response.json([{ result: { data: { _id: 'a', username: 'Alpha' } } }]));
    await expect(client.getMany('user.getUserLite', [{ userId: 'a' }, { userId: 'b' }], playerSchema)).rejects.toThrow('invalid tRPC batch');
    fetcher.mockResolvedValueOnce(Response.json([
      { result: { data: { _id: 'a', username: 'Alpha' } } },
      { error: { message: 'unavailable' } },
    ]));
    await expect(client.getMany('user.getUserLite', [{ userId: 'a' }, { userId: 'b' }], playerSchema)).rejects.toThrow('batch item 1 returned an invalid tRPC envelope');
  });

  it('checks batch size and procedure before fetching, while empty input is free', async () => {
    const fetcher = vi.fn();
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.getMany('user.getUserLite', [], playerSchema)).resolves.toEqual([]);
    await expect(client.getMany('user/getUserLite', [], playerSchema)).rejects.toThrow('Invalid procedure');
    await expect(client.getMany('user.getUserLite', Array.from({ length: 11 }, (_, i) => ({ userId: String(i) })), playerSchema)).rejects.toThrow('exceeds 10');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a batch rate limit and its retry window without returning partial data', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'rate limit' }, { status: 429, headers: { 'retry-after': '25', 'ratelimit-remaining': '0' } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.getMany('user.getUserLite', [{ userId: 'a' }], playerSchema)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 25 } satisfies Partial<WarEraError>);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a short batch rate limit and validates the eventual response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'rate limit' }, { status: 429, headers: { 'retry-after': '0.1', 'ratelimit-remaining': '0' } }))
      .mockResolvedValueOnce(Response.json([{ result: { data: { _id: 'a', username: 'Alpha' } } }], { headers: { 'ratelimit-remaining': '99' } }));
    const client = new WarEraClient(undefined, undefined, fetcher as typeof fetch);
    await expect(client.getMany('user.getUserLite', [{ userId: 'a' }], playerSchema)).resolves.toEqual([{ _id: 'a', username: 'Alpha' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
