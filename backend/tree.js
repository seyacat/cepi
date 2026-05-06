// Árbol de decisión — define ramas, preguntas y botones

export const MENU_PRINCIPAL = [
  { id: 'consulta', label: '📋 Consulta dermatológica' },
  { id: 'cita',     label: '📅 Agendar una cita' },
  { id: 'buscar',   label: '🔍 Buscar información' },
  { id: 'login',    label: '🔐 Acceso al sistema' },
  { id: 'otro',     label: '💬 Otra consulta' },
];

export const PREGUNTAS_CONSULTA = [
  '¿En qué zona del cuerpo se presenta y cómo es la lesión (color, tamaño, textura, líquido, costras)?',
  '¿Hace cuánto apareció? ¿Tienes síntomas adicionales como ardor, dolor, fiebre o descamación?',
  '¿Has aplicado algo? ¿Tienes alergias, enfermedades previas o tomas medicación actualmente?',
];

// Detecta en qué rama está la conversación según el historial
export function detectarRama(messages) {
  const textos = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.toLowerCase());

  if (textos.some((t) =>
    t.includes('consulta') || t.includes('síntoma') || t.includes('sintoma') ||
    t.includes('roncha') || t.includes('lesión') || t.includes('piel') ||
    t.includes('picor') || t.includes('mancha') || t.includes('ampolla') ||
    t.includes('dermatol')
  )) return 'consulta';

  if (textos.some((t) => t.includes('cita') || t.includes('agendar') || t.includes('turno') || t.includes('reservar')))
    return 'cita';

  if (textos.some((t) => t.includes('buscar') || t.includes('información') || t.includes('informacion') || t.includes('qué es') || t.includes('que es')))
    return 'buscar';

  if (textos.some((t) => t.includes('login') || t.includes('acceso') || t.includes('ingresar') || t.includes('contraseña') || t.includes('cuenta')))
    return 'login';

  return 'libre';
}
