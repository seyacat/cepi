/**
 * Tests for the episode-images helper that backs both the
 * GET /api/bot/episode-images endpoint and the "mostrar resultados imagen"
 * command. Uses a fake MCP client (no network / DB).
 */
import { describe, it, expect } from 'vitest';
import {
  listEpisodeImagesWithClassifications,
  CLINICAL_IMAGE_ENTITY_ID,
} from '../src/episodeImages.js';

/** Fake MCP client — scripted entities.list / classifications.list. */
function fakeMcp(images: any[], classByEntity: Record<string, any[]>) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    async call(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'entities.list') return { ok: true, data: images };
      if (name === 'classifications.list') {
        return { ok: true, data: classByEntity[args.entity_id] || [] };
      }
      return { ok: false, error: `unknown ${name}` };
    },
  } as any;
}

describe('listEpisodeImagesWithClassifications', () => {
  it('lists episode images filtered by clinical_image type and episode_id column', async () => {
    const mcp = fakeMcp([], {});
    await listEpisodeImagesWithClassifications(mcp, 'ep-1');
    const listCall = mcp.calls.find((c: any) => c.name === 'entities.list')!;
    expect(listCall.args.type).toBe(CLINICAL_IMAGE_ENTITY_ID);
    // episode_id is a UUID column → exact-match filter, not free-text search.
    expect(listCall.args.filter).toEqual({ episode_id: 'ep-1' });
    expect(listCall.args.search).toBeUndefined();
  });

  it('maps each image with its classifications and a file_url', async () => {
    const images = [
      {
        id: 'img-1',
        created_at: '2026-05-01T00:00:00Z',
        data: {
          attachment_id: 'att-1',
          field_key: 'lesion',
          privada: false,
          embedding_status: 'done',
        },
      },
      {
        id: 'img-2',
        created_at: '2026-05-02T00:00:00Z',
        data: {
          attachment_id: 'att-2',
          field_key: 'lesion',
          privada: true,
          embedding_status: 'pending',
        },
      },
    ];
    const classByEntity = {
      'img-1': [
        { model_id: 'isic-bin-triage-v1', labels: [{ label: 'no_melanoma', confidence: 0.9 }], raw: {} },
        { model_id: 'isic-multiclass-v1', labels: [{ label: 'nv', confidence: 0.7 }], raw: {} },
      ],
      'img-2': [],
    };
    const mcp = fakeMcp(images, classByEntity);
    const out = await listEpisodeImagesWithClassifications(mcp, 'ep-1');

    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('img-1');
    expect(out[0].file_url).toBe('/api/attachments/att-1/file');
    expect(out[0].privada).toBe(false);
    expect(out[0].classifications).toHaveLength(2);
    expect(out[0].classifications[0].model_id).toBe('isic-bin-triage-v1');

    // Second image: face detected → privada, pending classification.
    expect(out[1].privada).toBe(true);
    expect(out[1].embedding_status).toBe('pending');
    expect(out[1].classifications).toHaveLength(0);
  });

  it('handles an image without attachment_id (null file_url)', async () => {
    const images = [{ id: 'img-x', created_at: null, data: { field_key: 'lesion' } }];
    const mcp = fakeMcp(images, {});
    const out = await listEpisodeImagesWithClassifications(mcp, 'ep-1');
    expect(out[0].attachment_id).toBeNull();
    expect(out[0].file_url).toBeNull();
  });
});
