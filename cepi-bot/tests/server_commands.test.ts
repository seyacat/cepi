/**
 * Server-side command parsing tests. We don't spin up the actual MCP / DB
 * here; we just regex-match the message and assert what the server *would*
 * stage. Pure unit tests of the dispatch logic.
 *
 * The full HTTP integration test (boot backend + bot + supertest) lives
 * in TodoERP/backend/tests/mcp_generality.test.ts.
 */
import { describe, it, expect } from 'vitest';

// The server's command dispatchers are inline regexes; reproducing them
// here keeps the contract explicit and lets us refactor safely.
const RE = {
  setPatient:    /^\/?\s*activar\s+paciente\s+([0-9a-f-]{36})\s*$/i,
  setEpisode:    /^\/?\s*activar\s+episodio\s+([0-9a-f-]{36})\s*$/i,
  clrPatient:    /^\/?\s*(salir|cerrar|olvidar)\s+paciente\s*$/i,
  clrEpisode:    /^\/?\s*(salir|cerrar|olvidar)\s+episodio\s*$/i,
  newEpisode:    /^\/?\s*nuevo\s+episodio\b\s*(.*)$/i,
  closeEpisode:  /^\/?\s*cerrar\s+episodio\b\s*([0-9]{4}-[0-9]{2}-[0-9]{2})?\s*(.*)$/i,
  diagnostico:   /^\/?\s*diagn[óo]stico\s+([A-Z][0-9]{1,2}(?:\.[0-9]{1,2})?)\s+(.+)$/i,
  escalar:       /^\/?\s*escalar\s+a\s+([0-9a-f-]{36})\s+(.+)$/i,
  signs:         /^\/?\s*signs?\s+(.+)$/i,
  exportar:      /^\s*\/?\s*exportar\s*(anonimizado)?\s*$/i,
  attachment:    /\[adjunto:\s*([^·]+)·\s*([0-9a-f-]{36})\s*\]/i,
  imageResults:  /^\/?\s*mostrar\s+resultados?\s+(?:de\s+(?:las?\s+)?)?im[áa]gen(?:es)?\b\s*(.*)$/i,
  confirmYes:    /^\s*(s[ií]|si|confirmar|ok|adelante|yes)\s*$/i,
  confirmNo:     /^\s*(no|cancelar|cancel|abort)\s*$/i,
};

const VALID_UUID = '11000000-0000-0000-1000-000000000001';

describe('command regexes', () => {
  it('matches "activar paciente <uuid>"', () => {
    expect(`activar paciente ${VALID_UUID}`.match(RE.setPatient)?.[1]).toBe(VALID_UUID);
    expect('/activar paciente '.match(RE.setPatient)).toBeNull();
  });

  it('matches "salir paciente" with all 3 verbs', () => {
    for (const v of ['salir', 'cerrar', 'olvidar']) {
      expect(`${v} paciente`.match(RE.clrPatient)).not.toBeNull();
    }
  });

  it('matches "nuevo episodio <motivo>" and captures motivo', () => {
    expect('nuevo episodio control de nevus'.match(RE.newEpisode)?.[1]).toBe('control de nevus');
    expect('nuevo episodio'.match(RE.newEpisode)?.[1]).toBe('');
  });

  it('matches "cerrar episodio YYYY-MM-DD motivo"', () => {
    const m = 'cerrar episodio 2026-07-01 control evolución'.match(RE.closeEpisode);
    expect(m?.[1]).toBe('2026-07-01');
    expect(m?.[2]).toBe('control evolución');
  });

  it('matches /diagnostico C43.9 …', () => {
    const m = 'diagnostico C43.9 melanoma maligno'.match(RE.diagnostico);
    expect(m?.[1]).toBe('C43.9');
    expect(m?.[2]).toBe('melanoma maligno');
  });

  it('matches /escalar a <uuid> <razón>', () => {
    const m = `escalar a ${VALID_UUID} sospecha alta`.match(RE.escalar);
    expect(m?.[1]).toBe(VALID_UUID);
    expect(m?.[2]).toBe('sospecha alta');
  });

  it('matches signs k=v k=v', () => {
    const m = 'signs PA=120/80 FC=70'.match(RE.signs);
    expect(m?.[1]).toBe('PA=120/80 FC=70');
  });

  it('matches "exportar" and "exportar anonimizado"', () => {
    expect('exportar'.match(RE.exportar)).not.toBeNull();
    expect('exportar anonimizado'.match(RE.exportar)?.[1]).toBe('anonimizado');
  });

  it('matches the attachment marker emitted by the uploader', () => {
    const m = `[adjunto: foto.jpg · ${VALID_UUID}]`.match(RE.attachment);
    expect(m?.[1].trim()).toBe('foto.jpg');
    expect(m?.[2]).toBe(VALID_UUID);
  });

  it('matches "mostrar resultados imagen" and its variants', () => {
    for (const cmd of [
      'mostrar resultados imagen',
      'mostrar resultados imágenes',
      'mostrar resultado de la imagen',
      'mostrar resultados de imagenes',
      '/mostrar resultados imagen',
      // scoped to specific clinical_image ids (the §4.7 auto-flow form)
      'mostrar resultados imagen 22d9574f-82d7-4936-8105-31674474f47c',
    ]) {
      expect(cmd.match(RE.imageResults), cmd).not.toBeNull();
    }
    // the captured trailing group carries the optional ids
    const scoped = 'mostrar resultados imagen 22d9574f-82d7-4936-8105-31674474f47c'
      .match(RE.imageResults);
    expect(scoped?.[1]?.trim()).toBe('22d9574f-82d7-4936-8105-31674474f47c');
    expect('mostrar imagen'.match(RE.imageResults)).toBeNull();
    expect('mostrar resultados'.match(RE.imageResults)).toBeNull();
  });

  it('matches confirmYes / confirmNo vocabulary', () => {
    for (const yes of ['sí', 'si', 'ok', 'confirmar', 'adelante', 'yes']) {
      expect(yes.match(RE.confirmYes)).not.toBeNull();
    }
    for (const no of ['no', 'cancelar', 'abort', 'cancel']) {
      expect(no.match(RE.confirmNo)).not.toBeNull();
    }
  });
});
