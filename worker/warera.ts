import { z } from 'zod';

export const objectSchema = z.object({ _id: z.string().min(1) });
export const namedSchema = objectSchema.extend({ name: z.string().min(1) });
export const articleSchema = objectSchema.extend({ title: z.string().min(1) });
export const playerSchema = objectSchema.extend({ username: z.string().min(1) }).passthrough();
export const pageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
}).passthrough();
export const pricesSchema = z.record(z.string(), z.number().finite().nonnegative());
const envelopeSchema = z.object({ result: z.object({ data: z.unknown() }) });

export class WarEraError extends Error {
  constructor(message: string, public status?: number, public retryAfterSeconds?: number) { super(message); }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeBase = (base: string) => {
  const url = new URL(base);
  if (url.protocol !== 'https:') throw new WarEraError('WarEra API base must use HTTPS');
  return url.href.replace(/\/$/, '');
};
const validProcedure = (procedure: string) => /^[a-zA-Z]+\.[a-zA-Z]+$/.test(procedure);

/** Fixed-procedure tRPC client. Only public calls are used by ingestion. */
export class WarEraClient {
  private remaining: number | null = null;
  private resetSeconds = 60;
  constructor(
    baseUrl = 'https://api2.warera.io/trpc',
    private apiKey?: string,
    private fetcher: typeof fetch = ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
  ) { this.baseUrl = safeBase(baseUrl); }
  private baseUrl: string;

  url(procedure: string, input?: Record<string, unknown>): string {
    if (!validProcedure(procedure)) throw new WarEraError('Invalid procedure');
    const url = new URL(`${this.baseUrl}/${procedure}`);
    if (input && Object.keys(input).length) url.searchParams.set('input', JSON.stringify(input));
    return url.toString();
  }

  private async request(url: string, method: 'GET' | 'POST', body?: string): Promise<unknown> {
    if (this.remaining !== null && this.remaining <= 1) throw new WarEraError('WarEra rate limit nearly exhausted', 429, this.resetSeconds);
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method, signal: controller.signal,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}) },
          ...(body === undefined ? {} : { body }),
        });
      } catch (error) {
        clearTimeout(timer);
        if(error instanceof WarEraError)throw error;
        if (attempt < 2) { await wait(250 * 2 ** attempt); continue; }
        throw new WarEraError(error instanceof Error ? error.message : 'WarEra fetch failed');
      }
      const remaining = Number(response.headers.get('ratelimit-remaining'));
      const reset = Number(response.headers.get('ratelimit-reset'));
      if (Number.isFinite(remaining) && response.headers.has('ratelimit-remaining')) this.remaining = remaining;
      if (Number.isFinite(reset) && reset > 0) this.resetSeconds = reset;
      if (!response.ok) {
        clearTimeout(timer);
        const retryAfter = Number(response.headers.get('retry-after')) || this.resetSeconds;
        if ((response.status === 429 || response.status >= 500) && attempt < 2 && retryAfter <= 2) {
          await wait(Math.max(250 * 2 ** attempt, retryAfter * 1000)); continue;
        }
        throw new WarEraError(`WarEra HTTP ${response.status}`, response.status, response.status === 429 ? retryAfter : undefined);
      }
      try { return await response.json(); } catch { throw new WarEraError('WarEra returned invalid JSON'); }
      finally{clearTimeout(timer);}
    }
    throw new WarEraError('WarEra request exhausted retries');
  }

  async get<T>(procedure: string, input: Record<string, unknown> | undefined, schema: z.ZodType<T>): Promise<T> {
    const body = await this.request(this.url(procedure, input), 'GET');
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) throw new WarEraError('WarEra returned an invalid tRPC envelope');
    const parsed = schema.safeParse(envelope.data.result.data);
    if (!parsed.success) throw new WarEraError(`WarEra ${procedure} response failed schema validation`);
    return parsed.data;
  }

  /** Anonymous tRPC batching; every result is validated before any caller can persist it. */
  async getMany<T>(procedure: string, inputs: Record<string, unknown>[], schema: z.ZodType<T>): Promise<T[]> {
    if (!validProcedure(procedure)) throw new WarEraError('Invalid procedure');
    if (inputs.length > 10) throw new WarEraError('WarEra batch exceeds 10 procedures');
    if (!inputs.length) return [];
    const url = new URL(`${this.baseUrl}/${Array(inputs.length).fill(procedure).join(',')}`);
    url.searchParams.set('batch', '1');
    const indexedInputs = Object.fromEntries(inputs.map((input, index) => [String(index), input]));
    const body = await this.request(url.toString(), 'POST', JSON.stringify(indexedInputs));
    if (!Array.isArray(body) || body.length !== inputs.length) throw new WarEraError('WarEra returned an invalid tRPC batch');
    return body.map((item, index) => {
      const envelope = envelopeSchema.safeParse(item);
      if (!envelope.success) throw new WarEraError(`WarEra ${procedure} batch item ${index} returned an invalid tRPC envelope`);
      const parsed = schema.safeParse(envelope.data.result.data);
      if (!parsed.success) throw new WarEraError(`WarEra ${procedure} batch item ${index} response failed schema validation`);
      return parsed.data;
    });
  }
}

export const countryListSchema = z.array(namedSchema);
export const countryFeedSchema = z.custom<unknown[]>(Array.isArray);
export const countryDetailSchema = namedSchema.passthrough();
// The region map is large; validate its envelope here and each selected row during normalization.
export const regionsObjectSchema = z.custom<Record<string, unknown>>(value => value !== null && typeof value === 'object' && !Array.isArray(value));
export const regionDetailSchema = objectSchema.passthrough();
export const pagedObjectsSchema = pageSchema;
export const pagedPlayersSchema = pageSchema.extend({ items: z.array(objectSchema) });
