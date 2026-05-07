/**
 * Outbound PII redaction for tool results before they reach the LLM
 * (PAPER §13.3.1). Even when the user has pii:read:* and the backend
 * returns data in the clear (R4 of REFACTOR_PLAN), the agent's outgoing
 * prompt should not echo PII back to the model. Belt-and-suspenders.
 *
 * The list is conservative and hardcoded for now; a future iteration can
 * fetch entity_definitions and read each field's `pii:true` flag.
 */
const PII_KEYS = new Set<string>([
  'nombre', 'apellidos', 'cedula', 'email', 'telefono', 'direccion',
  'fecha_nac', 'sexo', 'tipo_sangre',
  // Bot session reflects the user; redact these too:
  'user_id',
]);

const REDACTED = '<REDACTED>';

function isObject(v: any): v is Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function redactPiiDeep<T = unknown>(value: T): T {
  if (Array.isArray(value)) {
    return (value.map(v => redactPiiDeep(v)) as unknown) as T;
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_KEYS.has(k)) {
        out[k] = v === null || v === undefined ? v : REDACTED;
      } else {
        out[k] = redactPiiDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

/** Convenience for stringify-then-feed-to-LLM paths. */
export function redactPiiInJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(redactPiiDeep(parsed));
  } catch {
    return raw;
  }
}
