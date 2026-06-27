import { describe, it, expect } from 'vitest';
import { coercePatch, coerceFichaValue } from '../src/flowV1.js';

/**
 * El LLM, al extraer datos de texto libre, produce valores en lenguaje natural
 * que la BD rechaza (CHECK de los select). coercePatch los mapea a la opción
 * válida y descarta lo no mapeable, en vez de fallar "Validación fallida".
 */
describe('coercePatch — campos select', () => {
  it('mapea lenguaje natural a la opción válida (caso "hombre negro")', () => {
    expect(coercePatch({ sexo: 'hombre', etnia: 'negro' })).toEqual({ sexo: 'M', etnia: 'afro' });
  });

  it('mapea sinónimos largos', () => {
    expect(coercePatch({ sexo: 'masculino', etnia: 'afrodescendiente' })).toEqual({ sexo: 'M', etnia: 'afro' });
    expect(coercePatch({ sexo: 'mujer', etnia: 'mestizo' })).toEqual({ sexo: 'F', etnia: 'mestiza' });
    expect(coercePatch({ escolaridad_grado: 'universitario' })).toEqual({ escolaridad_grado: 'tercer nivel' });
    expect(coercePatch({ condicion_socioeconomica: 'media' })).toEqual({ condicion_socioeconomica: 'medio' });
  });

  it('acepta valores ya canónicos (con/ sin acentos/caso)', () => {
    expect(coercePatch({ sexo: 'M', etnia: 'afro' })).toEqual({ sexo: 'M', etnia: 'afro' });
    expect(coercePatch({ escolaridad_grado: 'BASICO' })).toEqual({ escolaridad_grado: 'básico' });
  });

  it('descarta valores no mapeables (no fuerza inválidos)', () => {
    expect(coercePatch({ sexo: 'xyz', etnia: '???' })).toEqual({});
  });

  it('deja intactos los campos no-select', () => {
    expect(coercePatch({ nombre: 'Juan', telefono: '0991', sexo: 'hombre' }))
      .toEqual({ nombre: 'Juan', telefono: '0991', sexo: 'M' });
  });

  it('coerceFichaValue devuelve el valor tal cual para claves desconocidas', () => {
    expect(coerceFichaValue('nombre', 'Juan')).toBe('Juan');
    expect(coerceFichaValue('sexo', 'varón')).toBe('M');
  });
});
