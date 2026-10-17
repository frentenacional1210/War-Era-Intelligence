import { describe, expect, it } from 'vitest';
import { operationsHealth } from '../shared/operations';

const now = new Date('2026-10-18T12:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const base = { now, errorsLastHour: 0, runsLastHour: 40, collectorSourcesPaused: false };

describe('collector and run health for administrators', () => {
  it('is quiet while the collector commits and runs succeed', () => {
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(5) })).toMatchObject({ level: 'ok', messages: [] });
  });
  it('warns after an hour and escalates after three hours without commits', () => {
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(75) })).toMatchObject({ level: 'warn' });
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(200) }).level).toBe('bad');
    expect(operationsHealth({ ...base, lastCollectorCommitAt: null }).level).toBe('warn');
  });
  it('does not blame the collector during an expected quota pause', () => {
    const health = operationsHealth({ ...base, lastCollectorCommitAt: ago(600), collectorSourcesPaused: true });
    expect(health.level).toBe('ok');
    expect(health.messages[0]).toContain('cuota diaria');
  });
  it('flags a high failure share but ignores isolated errors', () => {
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(5), errorsLastHour: 2, runsLastHour: 4 }).level).toBe('ok');
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(5), errorsLastHour: 10, runsLastHour: 40 }).level).toBe('warn');
    expect(operationsHealth({ ...base, lastCollectorCommitAt: ago(5), errorsLastHour: 25, runsLastHour: 40 }).level).toBe('bad');
  });
});
