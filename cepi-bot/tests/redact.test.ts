import { describe, it, expect } from 'vitest';
import { redactPiiDeep, redactPiiInJson } from '../src/redact.js';

describe('redactPiiDeep', () => {
  it('redacts top-level PII fields', () => {
    expect(redactPiiDeep({ nombre: 'Ana', tipo_sangre: 'A+', notas: 'libre' })).toEqual({
      nombre: '<REDACTED>', tipo_sangre: '<REDACTED>', notas: 'libre',
    });
  });

  it('redacts deep inside nested data', () => {
    const input = {
      id: 'x',
      data: { nombre: 'Ana', apellidos: 'Pérez', email: 'a@b.com', alergias: 'penicilina' },
    };
    const out = redactPiiDeep(input) as any;
    expect(out.data.nombre).toBe('<REDACTED>');
    expect(out.data.apellidos).toBe('<REDACTED>');
    expect(out.data.email).toBe('<REDACTED>');
    expect(out.data.alergias).toBe('penicilina');
  });

  it('redacts inside arrays', () => {
    const out = redactPiiDeep([{ nombre: 'A' }, { nombre: 'B' }]) as any[];
    expect(out[0].nombre).toBe('<REDACTED>');
    expect(out[1].nombre).toBe('<REDACTED>');
  });

  it('keeps null/undefined as-is', () => {
    const out = redactPiiDeep({ nombre: null, telefono: undefined }) as any;
    expect(out.nombre).toBeNull();
    expect(out.telefono).toBeUndefined();
  });
});

describe('redactPiiInJson', () => {
  it('round-trips a JSON string with PII redacted', () => {
    const raw = JSON.stringify({ nombre: 'Ana', notas: 'ok' });
    const out = JSON.parse(redactPiiInJson(raw));
    expect(out.nombre).toBe('<REDACTED>');
    expect(out.notas).toBe('ok');
  });

  it('returns the raw string when not JSON', () => {
    expect(redactPiiInJson('not json')).toBe('not json');
  });
});
