import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import 'dotenv/config';
import { searchWeb } from './tools/searchWeb.js';
import { MENU_PRINCIPAL, PREGUNTAS_CONSULTA, detectarRama } from './tree.js';

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey:  process.env.DEEPSEEK_API_KEY,
});
const MODEL = process.env.AI_MODEL || 'deepseek-chat';

function buildSearchQuery(messages) {
  return messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ')
    + ' skin dermatology diagnostic medicine';
}

async function streamText(systemContent, messages, res) {
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: systemContent }, ...messages],
    stream: true,
  });
  for await (const chunk of stream) {
    const c = chunk.choices[0]?.delta?.content || '';
    if (c) send({ content: c });
  }
}

async function sendText(text, res) {
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  for (const char of text) {
    send({ content: char });
    await new Promise((r) => setTimeout(r, 4));
  }
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const userTurn = messages.filter((m) => m.role === 'user').length;
    const lastMsg = messages[messages.length - 1].content.toLowerCase();
    const rama = detectarRama(messages);

    // ── RAMA: CONSULTA DERMATOLÓGICA ─────────────────────────────────────────
    if (rama === 'consulta') {
      // Contar cuántos turnos llevan dentro de la rama consulta
      // (excluye el primer mensaje de selección si fue un botón)
      const turnosConsulta = messages.filter((m) => m.role === 'user').length;

      send({ status: 'Buscando información médica relevante…' });
      const hits = await searchWeb(buildSearchQuery(messages));
      const ctx = hits.map((h) => `[${h.title}] ${h.snippet}`).join('\n');

      if (turnosConsulta <= 3) {
        const pregunta = PREGUNTAS_CONSULTA[turnosConsulta - 1];

        // Acuse corto del modelo (max 60 tokens)
        const acuseRes = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'Confirma en UNA FRASE corta y objetiva (máx 12 palabras) el síntoma mencionado. Sin recomendaciones ni preguntas.' },
            { role: 'user', content: messages[messages.length - 1].content },
          ],
          stream: false,
          max_tokens: 60,
        });
        const acuse = acuseRes.choices[0].message.content.trim();
        await sendText(`${acuse}\n\n**${pregunta}**`, res);

      } else {
        // Recomendación final
        await streamText(
          `Eres el asistente de CEPI Centro de la Piel. Tono clínico y objetivo, sin empatía ni emojis, sin referencias a ser IA.
REGLAS: nunca diagnóstico definitivo, siempre probabilidades y alternativas, máx 10 párrafos cortos.
Termina SIEMPRE con: "⚠️ Esta información es orientativa y no reemplaza una consulta médica profesional. Te recomendamos acudir a un dermatólogo de CEPI para una evaluación oficial."
CONTEXTO MÉDICO:\n${ctx}`,
          messages, res
        );
        // Ofrecer volver al menú
        send({ buttons: [{ id: 'menu', label: '🏠 Volver al menú' }] });
      }
    }

    // ── RAMA: AGENDAR CITA ───────────────────────────────────────────────────
    else if (rama === 'cita') {
      await sendText(
        'Para agendar una cita con un especialista de CEPI tienes estas opciones:',
        res
      );
      send({
        buttons: [
          { id: 'cita_online', label: '🌐 Agendar en cepi.ec' },
          { id: 'cita_whatsapp', label: '💬 Contactar por WhatsApp' },
          { id: 'menu', label: '🏠 Volver al menú' },
        ],
      });
    }

    // ── RAMA: BUSCAR INFORMACIÓN ─────────────────────────────────────────────
    else if (rama === 'buscar') {
      send({ status: 'Buscando…' });
      const hits = await searchWeb(lastMsg + ' dermatology skin');
      const ctx = hits.map((h) => `[${h.title}] ${h.snippet}`).join('\n');
      await streamText(
        `Eres el asistente de CEPI. Responde en español, tono objetivo, máx 5 párrafos cortos.
Usa la siguiente información como contexto:\n${ctx}`,
        messages, res
      );
      send({ buttons: [
        { id: 'buscar', label: '🔍 Buscar otra cosa' },
        { id: 'menu', label: '🏠 Volver al menú' },
      ]});
    }

    // ── RAMA: LOGIN / ACCESO ─────────────────────────────────────────────────
    else if (rama === 'login') {
      await sendText(
        'Para acceder al sistema de CEPI utiliza el portal de pacientes en cepi.ec. Si olvidaste tu contraseña puedes recuperarla desde la misma página.',
        res
      );
      send({
        buttons: [
          { id: 'login_portal', label: '🔐 Ir al portal cepi.ec' },
          { id: 'menu', label: '🏠 Volver al menú' },
        ],
      });
    }

    // ── LIBRE: el usuario escribió algo no clasificado ───────────────────────
    else {
      await streamText(
        'Eres el asistente de CEPI Centro de la Piel. Responde en español, tono objetivo y conciso.',
        messages, res
      );
      send({ buttons: MENU_PRINCIPAL });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    send({ error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend on http://localhost:${PORT} — model: ${MODEL}`));
