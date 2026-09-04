/**
 * `fichaCompleta` / `fichaBookmarksFor` — la ficha vista desde el portal de casos
 * (PAPER §22), sin sesión de chat detrás.
 *
 * Lo que se protege acá es la distinción entre dos preguntas que parecen la misma:
 *   done    → ¿está contestada la pregunta ANCLA del grupo? Decide qué pregunta el chat.
 *   conDato → ¿el grupo tiene ALGO? Decide si el portal lo muestra como vacío.
 * Confundirlas hace que una ficha importada de DrPro se lea como si le faltaran datos
 * que en realidad tiene, que es justo lo que el portal existe para evitar.
 */
import { describe, it, expect } from 'vitest';
import { fichaCompleta, fichaBookmarksFor, FICHA_GROUPS } from '../src/flowV1.js';

const PACIENTE = 'p-1';
const EPISODIO = 'e-1';

/** MCP falso: devuelve los datos que se le pasan según qué entidad le pidan. */
function fakeMcp(patientData: any = {}, episodeData: any = {}, listas: any[] = []) {
  return {
    get jwt() { return 't'; }, get apiKey() { return ''; }, get apiUrl() { return ''; },
    async connect() {}, async close() {},
    async call(name: string, args: any) {
      if (name === 'entities.get') {
        return { ok: true, data: { id: args.id, data: args.id === PACIENTE ? patientData : episodeData } };
      }
      if (name === 'entities.list') return { ok: true, data: listas };
      return { ok: false };
    },
  } as any;
}

const grupo = (r: any, label: string) => r.grupos.find((g: any) => g.label.startsWith(label));

describe('fichaCompleta', () => {
  it('devuelve los 27 grupos en orden, con o sin datos', async () => {
    const r = await fichaCompleta(fakeMcp(), { patientId: PACIENTE, episodeId: EPISODIO });
    expect(r.grupos).toHaveLength(FICHA_GROUPS.length);
    expect(r.grupos.map((g: any) => g.id)).toEqual(FICHA_GROUPS.map(g => g.id));
    expect(r.completos).toBe(0);
    expect(r.faltantes).toHaveLength(FICHA_GROUPS.length);
  });

  it('un grupo con el detalle lleno pero sin su booleano ancla NO se muestra vacío', async () => {
    // Es exactamente la forma de lo importado de DrPro: trae `antecedentes_personales`
    // pero nunca el `antecedentes_personales_presente` que el chat pregunta primero.
    const mcp = fakeMcp({ antecedentes_personales: 'ENFERMEDAD DE STILL' }, {});
    const r = await fichaCompleta(mcp, { patientId: PACIENTE, episodeId: EPISODIO });
    expect(grupo(r, '2.1').done).toBe(true);
    expect(r.faltantes).not.toContain('2.1 Antecedentes personales');
  });

  it('el mismo caso sigue contando como pendiente para el chat', async () => {
    // El flujo debe seguir preguntando el ancla; si no, se saltaría la pregunta.
    const marcas = await fichaBookmarksFor(
      fakeMcp({ antecedentes_personales: 'ENFERMEDAD DE STILL' }, {}),
      { patientId: PACIENTE, episodeId: EPISODIO },
    );
    const m = marcas.find(x => x.id === 'g_2_1')!;
    expect(m.done).toBe(false);      // la pregunta ancla sigue sin contestar
    expect(m.conDato).toBe(true);    // pero el grupo tiene información
  });

  it('el plan importado cuenta aunque el primer campo del grupo esté vacío', async () => {
    // g_7 empieza por `tratamiento_resumen`; el espejo escribe `plan`.
    const r = await fichaCompleta(fakeMcp({}, { plan: '1. CUIDADOS DE HERIDA' }), { patientId: PACIENTE, episodeId: EPISODIO });
    expect(grupo(r, '7 ').done).toBe(true);
  });

  it('prellena los valores de cada grupo desde su entidad destino', async () => {
    const r = await fichaCompleta(
      fakeMcp({ direccion: 'EL BOSQUE', telefono: '099' }, { motivo_consulta: 'CONTROL' }),
      { patientId: PACIENTE, episodeId: EPISODIO },
    );
    expect(grupo(r, '1.1').form.values).toMatchObject({ direccion: 'EL BOSQUE', telefono: '099' });
    expect(grupo(r, '3.1').form.values).toMatchObject({ motivo_consulta: 'CONTROL' });
  });

  it('no cruza datos entre paciente y episodio', async () => {
    // Cada grupo lee de SU entidad; un campo del episodio no debe aparecer en uno
    // de paciente ni al revés.
    const r = await fichaCompleta(fakeMcp({ motivo_consulta: 'NO CORRESPONDE' }, {}), { patientId: PACIENTE, episodeId: EPISODIO });
    expect(grupo(r, '3.1').form.values).toBeUndefined();
  });

  it('sin ids no inventa datos', async () => {
    const r = await fichaCompleta(fakeMcp({ direccion: 'X' }, {}), {});
    expect(r.completos).toBe(0);
    expect(grupo(r, '1.1').form.values).toBeUndefined();
  });

  it('los grupos de imagen se marcan por la existencia del registro, no por un campo', async () => {
    const conImagen = await fichaCompleta(fakeMcp({}, {}, [{ id: 'img-1' }]), { patientId: PACIENTE, episodeId: EPISODIO });
    expect(grupo(conImagen, '4.7').done).toBe(true);
    const sinImagen = await fichaCompleta(fakeMcp({}, {}, []), { patientId: PACIENTE, episodeId: EPISODIO });
    expect(grupo(sinImagen, '4.7').done).toBe(false);
  });
});
