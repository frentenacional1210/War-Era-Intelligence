import { describe, expect, it } from 'vitest';
import { displayName, localizedTitle } from '../src/utils';

describe('Spanish display of stored English event titles', () => {
  it('translates known event titles and battle names but leaves player data untouched', () => {
    expect(displayName({ name: 'Election finished in public record' })).toBe('Elección finalizada según el registro público');
    expect(localizedTitle('Observed market price change over 20%')).toBe('Cambio de precio de mercado superior al 20 %');
    expect(localizedTitle('Battle 1a2b3c4d')).toBe('Batalla 1a2b3c4d');
    expect(displayName({ name: 'Battle Royale Fan' })).toBe('Battle Royale Fan');
    expect(displayName({ title: 'Active battle observed in Spain' })).toBe('Active battle observed in Spain');
  });
});
