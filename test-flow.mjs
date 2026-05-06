// Prueba el flujo completo del bot: 3 preguntas + recomendación
const BASE = 'http://localhost:3001';

async function chat(messages) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  let output = '';
  let status = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') break;
      try {
        const { content, status: s } = JSON.parse(payload);
        if (s) status = s;
        if (content) output += content;
      } catch {}
    }
  }
  return { output, status };
}

const history = [];

const turns = [
  'tengo unas ronchas rojas en el pie que pican mucho',
  'están en la planta del pie, son pequeñas y con líquido adentro',
  'llevan 4 días, también me arden un poco, no he usado nada todavía',
  'no tengo alergias conocidas ni enfermedades previas',
];

console.log('=== TEST FLUJO BOT CEPI ===\n');

for (let i = 0; i < turns.length; i++) {
  const userMsg = turns[i];
  history.push({ role: 'user', content: userMsg });

  console.log(`--- TURNO ${i + 1} ---`);
  console.log(`USUARIO: ${userMsg}`);

  const { output, status } = await chat(history);
  if (status) console.log(`[status] ${status}`);
  console.log(`BOT: ${output}`);
  console.log();

  history.push({ role: 'assistant', content: output });

  // Verificar comportamiento esperado
  const userTurn = i + 1;
  if (userTurn <= 3) {
    const hasQuestion = output.includes('?');
    const hasRecommendation = /recomend|diagnós|tratamiento|acudir|cepi/i.test(output) && output.length > 400;
    console.log(`  ✓ Tiene pregunta: ${hasQuestion ? 'SÍ' : '❌ NO'}`);
    console.log(`  ✓ Evita recomendar: ${!hasRecommendation ? 'SÍ' : '❌ SE PASÓ - respuesta larga con recomendación'}`);
  } else {
    const hasWarning = output.includes('⚠️');
    const hasPossibilities = /podría|posibilidad|posible|probable|frecuente/i.test(output);
    console.log(`  ✓ Incluye aviso ⚠️: ${hasWarning ? 'SÍ' : '❌ NO'}`);
    console.log(`  ✓ Usa lenguaje probabilístico: ${hasPossibilities ? 'SÍ' : '❌ NO'}`);
  }
  console.log();
}

console.log('=== FIN DEL TEST ===');
