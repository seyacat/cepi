#!/usr/bin/env node
// Loop Claude Code on a paper checklist until it reports done.
// Usage: node scripts/run-until-done.mjs <paper.md> [--max N]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('usage: node scripts/run-until-done.mjs <paper.md> [--max N]');
  process.exit(2);
}
const paper = resolve(args[0]);
let max = 50;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--max') max = parseInt(args[++i], 10);
  else { console.error('arg desconocido:', args[i]); process.exit(2); }
}
if (!existsSync(paper)) {
  console.error('no existe:', paper);
  process.exit(2);
}

const QUESTIONS_FILE = paper.replace(/\.md$/i, '') + '.questions.md';

const RULES =
`REGLAS DEL LOOP (importantes):
- NO me hagas preguntas ni pidas confirmación. Si tenés dudas, anotalas como bullets en ${QUESTIONS_FILE} (creá el archivo si no existe) y SEGUÍ trabajando eligiendo la solución que te parezca más lógica según el paper y CLAUDE.md.
- Si un item es imposible o requiere decisión externa irresoluble, marcalo \`[x]\` igual con nota "(skipped: razón)" en el paper, anotá la duda en ${QUESTIONS_FILE} y seguí con el siguiente.
- Solo terminás (done=true) cuando NO queden \`[ ]\` en el checklist activo del paper.`;

const STATUS_PROMPT =
`${RULES}

Revisá el checklist activo en ${paper} y respondé EXCLUSIVAMENTE con JSON válido en una sola línea, sin texto adicional, sin code fences, sin preguntas:
{"done": true|false, "pending": <int>, "next": "<descripcion corta del proximo item o null>"}
done=true solo si TODOS los \`[ ]\` del checklist activo están marcados \`[x]\`.`;

const WORK_PROMPT =
`${RULES}

Continuá ejecutando los items pendientes del checklist de ${paper}. Marcá \`[x]\` los que completes. Recordá: las dudas van a ${QUESTIONS_FILE}, no me las preguntes.`;

let session = '';

const TMP = mkdtempSync(join(tmpdir(), 'claude-loop-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

function ask(prompt) {
  return new Promise((resolveP, rejectP) => {
    const isWin = process.platform === 'win32';
    const promptFile = join(TMP, `p-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(promptFile, prompt, 'utf8');
    const resumeArg = session ? ` --resume ${session}` : '';
    const cmdline = isWin
      ? `type "${promptFile}" | claude -p --output-format json --permission-mode acceptEdits${resumeArg}`
      : `cat "${promptFile}" | claude -p --output-format json --permission-mode acceptEdits${resumeArg}`;
    // Comando como string único + shell:true: no dispara DEP0190 (no hay args array).
    const child = spawn(cmdline, { shell: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', rejectP);
    child.on('close', code => {
      try { rmSync(promptFile, { force: true }); } catch {}
      if (code !== 0) return rejectP(new Error(`claude exit ${code}: ${err}`));
      try { resolveP(JSON.parse(out)); }
      catch (e) { rejectP(new Error('respuesta no-JSON de claude:\n' + out)); }
    });
  });
}

function extractInner(result) {
  if (typeof result !== 'string') return null;
  const matches = result.match(/\{[^{}]*"done"[^{}]*\}/g);
  if (!matches) return null;
  try { return JSON.parse(matches[matches.length - 1]); }
  catch { return null; }
}

for (let i = 1; i <= max; i++) {
  console.log(`── iter ${i}: consultando estado ──`);
  const resp = await ask(STATUS_PROMPT);
  if (resp.session_id) session = resp.session_id;
  const inner = extractInner(resp.result);
  if (!inner) {
    console.error('respuesta sin JSON {done:...}; corto por seguridad.');
    console.error(resp.result ?? resp);
    process.exit(1);
  }
  console.log(`  done=${inner.done} pending=${inner.pending ?? '?'} next=${inner.next ?? ''}`);
  if (inner.done === true) {
    console.log(`✓ checklist completo en ${paper} (iter ${i})`);
    process.exit(0);
  }
  console.log(`── iter ${i}: pidiendo continuar ──`);
  const wresp = await ask(WORK_PROMPT);
  if (wresp.session_id) session = wresp.session_id;
}

console.error(`✗ alcanzado MAX=${max} iteraciones sin terminar`);
process.exit(1);
