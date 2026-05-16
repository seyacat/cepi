/**
 * Episode clinical-image helpers — shared by the /api/bot/episode-images
 * endpoint and the "mostrar resultados imagen" command. Read-only.
 */
import { TodoErpMcpClient } from './mcpClient.js';

export const CLINICAL_IMAGE_ENTITY_ID = '16000000-0000-0000-0000-000000000000';

/** HAM10000 → CIE-10 (dermatology subset), best-effort mapping. */
export const HAM_TO_ICD: Record<string, string[]> = {
  akiec: ['L82', 'Queratosis seborreica (queratosis actínica clínica)'],
  bcc:   ['C44.9', 'Cáncer de piel no melanoma (basocelular)'],
  bkl:   ['L82', 'Queratosis seborreica'],
  df:    ['D23.9', 'Dermatofibroma — neoplasia benigna de piel'],
  mel:   ['C43.9', 'Melanoma maligno de piel'],
  nv:    ['D22.9', 'Nevus melanocítico'],
  vasc:  ['L98.9', 'Lesión vascular cutánea'],
};

export interface EpisodeImage {
  id: string;
  attachment_id: string | null;
  field_key: string | null;
  privada: boolean;
  embedding_status: string | null;
  created_at: string | null;
  file_url: string | null;
  classifications: Array<{ model_id: string; labels: any[]; raw: any }>;
}

/**
 * List the clinical_image records of an episode together with each image's
 * AI classifications (entity_classifications via the classifications.list
 * MCP tool). Read-only.
 */
export async function listEpisodeImagesWithClassifications(
  mcp: Pick<TodoErpMcpClient, 'call'>, episodeId: string,
): Promise<EpisodeImage[]> {
  // episode_id is a UUID column — free-text `search` can't match it; the
  // backend needs an exact-match column `filter` instead.
  const list = await mcp.call('entities.list', {
    type: CLINICAL_IMAGE_ENTITY_ID,
    filter: { episode_id: episodeId },
    limit: 50,
  });
  const rows: any[] = Array.isArray(list.data) ? list.data : [];
  const out: EpisodeImage[] = [];
  for (const row of rows) {
    const data = row?.data || {};
    const attachmentId = data.attachment_id || null;
    const cls = await mcp.call('classifications.list', { entity_id: row.id });
    const classifications = (Array.isArray(cls.data) ? cls.data : []).map((c: any) => ({
      model_id: c.model_id,
      labels: Array.isArray(c.labels) ? c.labels : [],
      raw: c.raw ?? null,
    }));
    out.push({
      id: row.id,
      attachment_id: attachmentId,
      field_key: data.field_key || null,
      privada: !!data.privada,
      embedding_status: data.embedding_status || null,
      created_at: row.created_at || null,
      file_url: attachmentId ? `/api/attachments/${attachmentId}/file` : null,
      classifications,
    });
  }
  return out;
}
