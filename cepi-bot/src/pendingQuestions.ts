/**
 * Cola de dudas pendientes del agente.
 *
 * El problema: el LLM detecta que faltan cinco datos y los pregunta todos en un
 * mismo mensaje, que en el chat se lee como spam — y es inmanejable cuando el
 * médico contesta dictando. Pedirle en el prompt que pregunte de a una no basta:
 * sin memoria, las otras dudas se pierden y nunca vuelve a pedirlas.
 *
 * La solución: el LLM pregunta UNA y adjunta el resto en un marcador al final
 * del mensaje. Acá se extrae, se guarda en `session.pending_slots` y se le
 * reinyecta como contexto en el turno siguiente. El usuario nunca ve el marcador.
 */

/** `[[PENDIENTES: motivo de consulta | tiempo de evolución]]` */
const MARKER = /\[\[\s*PENDIENTES\s*:\s*([^\]]*)\]\]/i;

export interface ExtractedQuestions {
  /** El mensaje sin el marcador, que es lo que ve el usuario. */
  text: string;
  /** Las dudas listadas, o null si el mensaje no traía marcador. */
  questions: string[] | null;
}

export function extractPendingQuestions(text: string): ExtractedQuestions {
  const m = text.match(MARKER);
  if (!m) return { text, questions: null };

  const questions = m[1]
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);

  // Quitar el marcador deja saltos de línea y espacios colgando al final.
  const clean = text.replace(MARKER, '').replace(/\s+$/, '');
  return { text: clean, questions };
}

/**
 * Línea de contexto para el turno siguiente. Vacía si no hay nada pendiente,
 * para no gastar tokens ni sugerirle preguntas que ya no vienen al caso.
 */
export function pendingQuestionsNote(questions: string[]): string {
  if (!questions.length) return '';
  return (
    `Dudas pendientes de turnos anteriores: ${questions.join(' | ')}. ` +
    `Retoma SOLO la siguiente que siga sin responder, de a una. ` +
    `Quita de la lista lo que el usuario ya respondió y lo que dejó de aplicar.`
  );
}
