import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { csrfValid, takeLimit } from '../worker/auth';
import type { Env } from '../worker/types';

describe('public actor quota', () => {
  it('rejects concurrent last-slot requests and does not write again after the cap', async () => {
    const store = createTestDB();
    try {
      const env = { DB: store.db, SESSION_SECRET: 'test-secret-long-enough-for-hmac' } as Env;
      const request = new Request('https://wint.example/api/ai/query', { headers: { 'CF-Connecting-IP': '198.51.100.8' } });
      expect(await takeLimit(env, request, 'review-test', 2, 3600)).toBe(true);
      const lastSlot = await Promise.all([
        takeLimit(env, request, 'review-test', 2, 3600),
        takeLimit(env, request, 'review-test', 2, 3600),
      ]);
      expect(lastSlot.sort()).toEqual([false, true]);
      const before = Number(store.sqlite.prepare('SELECT total_changes() n').get()?.n);
      for (let i = 0; i < 4; i++) expect(await takeLimit(env, request, 'review-test', 2, 3600)).toBe(false);
      const after = Number(store.sqlite.prepare('SELECT total_changes() n').get()?.n);
      expect(after).toBe(before);
      expect(store.sqlite.prepare('SELECT hits FROM request_limits').get()?.hits).toBe(2);
    } finally { store.sqlite.close(); }
  });

  it('requires the custom CSRF header and rejects a foreign Origin', () => {
    expect(csrfValid(new Request('https://wint.example/api/ai/query', { method: 'POST', headers: { 'X-WINT-CSRF': '1', Origin: 'https://evil.example' } }))).toBe(false);
    expect(csrfValid(new Request('https://wint.example/api/ai/query', { method: 'POST', headers: { Origin: 'https://wint.example' } }))).toBe(false);
    expect(csrfValid(new Request('https://wint.example/api/ai/query', { method: 'POST', headers: { 'X-WINT-CSRF': '1', Origin: 'https://wint.example' } }))).toBe(true);
  });
});
