import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseImport, validateImport } from '../shared/import';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('importación', () => {
  it('normaliza IDs reales y elimina duplicados idénticos', () => {
    const result = parseImport('players.json', bytes(JSON.stringify([{ userId: 7, username: 'Ada' }, { userId: 7, username: 'Ada' }])));
    expect(result).toMatchObject({ records: [{ id: '7', name: 'Ada' }], errors: [], duplicates: 1 });
  });

  it('informa duplicados conflictivos sin sobrescribir el primero', () => {
    const result = validateImport('players', [{ id: '7', name: 'Ada' }, { id: '7', name: 'Eve' }]);
    expect(result.records).toEqual([{ id: '7', name: 'Ada' }]);
    expect(result.errors[0]).toContain('datos distintos');
  });

  it('acepta CSV y ZIP y rechaza rutas peligrosas', () => {
    expect(parseImport('censo.csv', bytes('id,username\n1,Ada\n')).records[0]).toMatchObject({ id: '1', name: 'Ada' });
    const archive = zipSync({ 'a.json': strToU8('[{"id":"1","name":"Ada"}]') });
    expect(parseImport('datos.zip', archive).records).toHaveLength(1);
    const unsafe = zipSync({ '../a.json': strToU8('[{"id":"1","name":"Ada"}]') });
    expect(parseImport('datos.zip', unsafe).errors[0]).toContain('ruta insegura');
  });

  it('rechaza archivos superiores al límite y recursos desconocidos', () => {
    expect(parseImport('a.json', new Uint8Array(1_048_577)).errors[0]).toContain('1 MB');
    expect(validateImport('battles', [{ id: '1' }]).errors).toHaveLength(1);
  });

  it('exige nombre y limita registros', () => {
    expect(validateImport('players', [{ id: '1' }]).errors[0]).toContain('nombre');
    expect(validateImport('players', Array.from({ length: 501 }, (_, id) => ({ id, name: 'Ada' }))).errors[0]).toContain('500');
  });

  it('publica solo campos de juego permitidos y descarta metadatos desconocidos', () => {
    const result = validateImport('players', [{ userId: 7, username: 'Ada', countryId: 'es', level: '4',
      leveling: { level: '4', totalXp: '100', internalNote: 'omit' }, stats: { damagesCount: 23, location: 'omit' },
      metadata: { personalNote: 'omit' }, unknownField: 'omit' }]);
    expect(result.errors).toEqual([]);
    expect(result.records[0]).toEqual({ id: '7', name: 'Ada', country_id: 'es', level: 4, experience: 100,
      leveling: { level: 4, totalXp: 100 }, stats: { damagesCount: 23 } });
  });

  it('rechaza credenciales y datos de contacto incluso dentro de campos descartados', () => {
    const result = parseImport('a.json', bytes(JSON.stringify([{ id: '1', name: 'Ada', metadata: { apiToken: 'private' } },
      { id: '2', name: 'Bea', email: 'bea@example.test' }])));
    expect(result.records).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(' ')).not.toContain('private');
    expect(result.errors.join(' ')).not.toContain('bea@example.test');
  });
});
