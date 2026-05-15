/**
 * WHO ICD-11 API client (https://icd.who.int/docs/icd-api/APIDoc-Version2/).
 *
 * OAuth2 client-credentials token (cached + auto-refreshed) plus a thin
 * MMS search wrapper. Credentials come from the environment so the
 * client_secret never reaches the browser:
 *   WHO_ICD_CLIENT_ID, WHO_ICD_CLIENT_SECRET
 */
const TOKEN_URL = 'https://icdaccessmanagement.who.int/connect/token';
// MMS = Mortality & Morbidity Statistics linearization (general clinical use).
const MMS_BASE = 'https://id.who.int/icd/release/11/2024-01/mms';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

  const clientId = process.env.WHO_ICD_CLIENT_ID;
  const clientSecret = process.env.WHO_ICD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('WHO_ICD_CLIENT_ID / WHO_ICD_CLIENT_SECRET no configurados');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'icdapi_access',
    grant_type: 'client_credentials',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`token ICD HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j: any = await res.json();
  cachedToken = {
    value: j.access_token,
    expiresAt: now + (Number(j.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

export interface IcdResult {
  /** ICD-11 code, e.g. "EK00" (empty for chapter/grouping entities). */
  code: string;
  /** Human-readable title (highlight markup stripped). */
  title: string;
  /** WHO entity URI. */
  uri: string;
}

/** Free-text search against the ICD-11 MMS linearization. */
export async function icdSearch(query: string): Promise<IcdResult[]> {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  const token = await getToken();
  const url = `${MMS_BASE}/search?` + new URLSearchParams({
    q,
    flatResults: 'true',
    highlightingEnabled: 'false',
  });
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'es',
      'API-Version': 'v2',
    },
  });
  if (!res.ok) {
    throw new Error(`búsqueda ICD HTTP ${res.status}`);
  }
  const j: any = await res.json();
  const ents: any[] = Array.isArray(j?.destinationEntities) ? j.destinationEntities : [];
  return ents
    .map((e): IcdResult => ({
      code: String(e?.theCode || ''),
      title: String(e?.title || '').replace(/<\/?em[^>]*>/gi, '').trim(),
      uri: String(e?.id || ''),
    }))
    .filter(r => r.title);
}
