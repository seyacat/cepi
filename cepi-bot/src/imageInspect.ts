/**
 * Lesion-image inspection — the medical-domain glue between the ficha's
 * §4.7 image-upload group and the cepi-isic service.
 *
 * cepi-isic's POST /inspect runs the *real* (non-stub) checks:
 *   - quality: minimum resolution + mean-brightness window (sub/over-exposed)
 *   - face detection: OpenCV haar cascade → image is marked `privada`
 *
 * This module just forwards each uploaded attachment to that endpoint,
 * passing an authenticated TodoERP file URL so cepi-isic can fetch the
 * binary without touching the DB. Keeping the clinical decision (skip
 * inadequate images, flag faces as private) here keeps TodoERP generic.
 */
import { TodoErpMcpClient } from './mcpClient.js';

const ISIC_URL = process.env.CEPI_ISIC_URL || 'http://localhost:8000';

export interface InspectResult {
  attachment_id: string;
  width?: number;
  height?: number;
  brightness?: number;
  adequate: boolean;
  reasons: string[];
  has_face: boolean;
  error?: string;
}

/**
 * Inspect one attachment via cepi-isic. Never throws — on transport/parse
 * failure it returns an `adequate: false` result so the caller can surface
 * the problem to the user instead of silently registering a bad image.
 */
export async function inspectAttachment(
  attachmentId: string, mcp: TodoErpMcpClient,
): Promise<InspectResult> {
  const fileUrl = `${mcp.apiUrl}/api/attachments/${attachmentId}/file`;
  const auth = mcp.jwt ? `Bearer ${mcp.jwt}` : '';
  try {
    const res = await fetch(`${ISIC_URL}/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachment_id: attachmentId,
        file_url: fileUrl,
        auth,
        ...(mcp.apiKey ? { api_key: mcp.apiKey } : {}),
      }),
    });
    if (!res.ok) {
      return {
        attachment_id: attachmentId, adequate: false, has_face: false,
        reasons: [`el servicio de inspección respondió ${res.status}`],
        error: `HTTP ${res.status}`,
      };
    }
    const j = await res.json() as any;
    return {
      attachment_id: attachmentId,
      width: j.width, height: j.height, brightness: j.brightness,
      adequate: !!j.adequate,
      reasons: Array.isArray(j.reasons) ? j.reasons : [],
      has_face: !!j.has_face,
      error: j.error,
    };
  } catch (err: any) {
    return {
      attachment_id: attachmentId, adequate: false, has_face: false,
      reasons: ['no pude contactar el servicio de inspección de imágenes'],
      error: err?.message || String(err),
    };
  }
}
