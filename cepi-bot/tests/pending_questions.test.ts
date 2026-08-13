import { describe, it, expect } from 'vitest';
import { extractPendingQuestions, pendingQuestionsNote } from '../src/pendingQuestions.js';

describe('extractPendingQuestions', () => {
  it('separa el marcador del texto visible', () => {
    const r = extractPendingQuestions(
      '¿Qué edad tiene el paciente?\n\n[[PENDIENTES: motivo de consulta | tiempo de evolución]]'
    );
    expect(r.text).toBe('¿Qué edad tiene el paciente?');
    expect(r.questions).toEqual(['motivo de consulta', 'tiempo de evolución']);
  });

  it('sin marcador devuelve questions=null para no pisar la cola guardada', () => {
    const r = extractPendingQuestions('¿Qué edad tiene?');
    expect(r.text).toBe('¿Qué edad tiene?');
    expect(r.questions).toBeNull();   // null ≠ [] : "no dijo nada" ≠ "ya no falta nada"
  });

  it('el marcador vacío sí vacía la cola', () => {
    const r = extractPendingQuestions('Listo, guardado.\n[[PENDIENTES: ]]');
    expect(r.text).toBe('Listo, guardado.');
    expect(r.questions).toEqual([]);
  });

  it('tolera espaciado y mayúsculas irregulares del LLM', () => {
    const r = extractPendingQuestions('Hola [[ pendientes :  a  |  b  ]]');
    expect(r.questions).toEqual(['a', 'b']);
    expect(r.text).toBe('Hola');
  });

  it('no deja rastro del marcador en el texto visible', () => {
    const r = extractPendingQuestions('Texto [[PENDIENTES: x]] final');
    expect(r.text).not.toMatch(/PENDIENTES/i);
  });
});

describe('pendingQuestionsNote', () => {
  it('no gasta contexto cuando no hay nada en cola', () => {
    expect(pendingQuestionsNote([])).toBe('');
  });

  it('lista las dudas e insiste en preguntar de a una', () => {
    const note = pendingQuestionsNote(['edad', 'motivo']);
    expect(note).toContain('edad | motivo');
    expect(note).toMatch(/de a una/i);
  });
});
