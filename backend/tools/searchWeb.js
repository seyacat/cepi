import axios from 'axios';
import * as cheerio from 'cheerio';

export async function searchWeb(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    timeout: 8000,
  });

  const $ = cheerio.load(data);
  const results = [];

  $('.result__body').each((i, el) => {
    if (i >= 5) return false;
    const title = $(el).find('.result__title').text().trim();
    const snippet = $(el).find('.result__snippet').text().trim();
    const link = $(el).find('.result__url').text().trim();
    if (title) results.push({ title, snippet, link });
  });

  return results;
}

export const searchWebTool = {
  type: 'function',
  function: {
    name: 'searchWeb',
    description: 'Busca información médica en la web. SIEMPRE traduce la consulta al inglés y agrégale "diagnostic medicine" al final antes de buscar. Devuelve los primeros resultados para usarlos como contexto y profundizar en la conversación.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta en INGLÉS con "diagnostic medicine" al final. Ejemplo: "cystic acne treatment diagnostic medicine"',
        },
      },
      required: ['query'],
    },
  },
};
