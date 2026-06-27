/**
 * cepi browser-bot — debugger multi-perfil.
 *
 * Levanta una ventana Chrome por rol (perfil aislado, auto-logueada) y expone
 * una API HTTP para controlarlas: navegar, click, tipear, screenshots, leer el
 * texto/console de la página y evaluar JS. Pensado para depurar la app desde la
 * perspectiva de cada rol, y para que el agente (Claude) la maneje por curl.
 *
 * Uso:
 *   node scripts/browser-bot/bot.cjs                 # abre todos los roles
 *   ROLES=primario,derma1 node ...bot.cjs            # subconjunto
 *   PORT=8899 FRONTEND=http://localhost:5174 node ...bot.cjs
 *
 * Debe correr en un entorno con DISPLAY (no en el sandbox del agente). El
 * agente controla por:  curl localhost:8899/...
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('/mnt/sda1/cepi/node_modules/playwright-core')); }

const PORT = Number(process.env.PORT || 8899);
const FRONTEND = process.env.FRONTEND || 'http://localhost:5174';
const PROFILE_BASE = process.env.PROFILE_BASE || '/tmp/cepi-prof';
const SHOTS = path.join(__dirname, 'shots');
// Layout en grilla. Por defecto: monitor DERECHO de una pantalla 3840x1080
// (x 1920..3840), grilla 3x2 (celdas de 640x540). Override por env.
const COLS  = Number(process.env.COLS  || 3);
const MON_X = Number(process.env.MON_X || 1920);
const MON_Y = Number(process.env.MON_Y || 0);
const CW    = Number(process.env.CELL_W || 640);
const CH    = Number(process.env.CELL_H || 540);
fs.mkdirSync(SHOTS, { recursive: true });

// Roles disponibles (password por defecto Admin123!). Editá/extendé acá.
const PASS = process.env.CEPI_PASS || 'Admin123!';
const ALL = [
  { role: 'primario',  hash: 'medico_primario', email: 'primario@cepi.local'  },
  { role: 'derma1',    hash: 'especialista',    email: 'derma1@cepi.local'    },
  { role: 'derma2',    hash: 'especialista',    email: 'derma2@cepi.local'    },
  { role: 'residente', hash: 'residente',       email: 'residente@cepi.local' },
  { role: 'super',     hash: 'supermedico',     email: 'super@cepi.local'     },
  { role: 'admin',     hash: 'admin',           email: 'admin@erp.com'        },
];
const want = (process.env.ROLES || 'primario,derma1,derma2,residente,super,admin').split(',').map(s => s.trim());
const targets = ALL.filter(t => want.includes(t.role));

const pages = {};   // role -> Page
const logs = {};    // role -> [{t,type,text}]  (console/pageerror ring buffer)

async function login(page, t) {
  await page.goto(FRONTEND + '/', { waitUntil: 'domcontentloaded' });
  const ok = await page.evaluate(async (c) => {
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.pass }) });
      const j = await r.json();
      if (j && j.token) { localStorage.setItem('cepi.jwt', j.token); localStorage.removeItem('cepi.session_id'); return true; }
      return false;
    } catch { return false; }
  }, { email: t.email, pass: PASS });
  await page.goto(`${FRONTEND}/#${t.hash}`, { waitUntil: 'domcontentloaded' });
  // Ir de "/" a "/#hash" es navegación del mismo documento (no recarga la SPA),
  // así que el token recién guardado no se re-evalúa. Forzamos un reload real.
  await page.reload({ waitUntil: 'domcontentloaded' });
  return ok;
}

async function start() {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try { fs.rmSync(path.join(PROFILE_BASE, t.role), { recursive: true, force: true }); } catch {}
    const ctx = await chromium.launchPersistentContext(path.join(PROFILE_BASE, t.role), {
      headless: false, channel: 'chrome', viewport: null,
      args: [`--window-position=${MON_X + (i % COLS) * CW},${MON_Y + Math.floor(i / COLS) * CH}`, `--window-size=${CW},${CH}`, '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-infobars'],
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    logs[t.role] = [];
    const push = (type, text) => { const a = logs[t.role]; a.push({ t: Date.now(), type, text: String(text).slice(0, 500) }); if (a.length > 80) a.shift(); };
    page.on('console', m => push(m.type(), m.text()));
    page.on('pageerror', e => push('pageerror', e.message));
    const ok = await login(page, t);
    pages[t.role] = page;
    console.log(`[bot] ${t.role.padEnd(10)} ${t.email.padEnd(22)} -> ${ok ? 'LOGUEADO' : 'FALLO'}`);
  }
  console.log(`[bot] listo — ${Object.keys(pages).length} ventana(s). API: http://localhost:${PORT}  (frontend ${FRONTEND})`);

  // Keep-alive: renueva el token en localStorage antes de que expire (TTL ~1h),
  // sin navegar (no interrumpe al usuario). Así las sesiones no se desloguean.
  setInterval(async () => {
    for (const t of targets) {
      const p = pages[t.role];
      if (!p) continue;
      try {
        await p.evaluate(async (c) => {
          const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.pass }) });
          const j = await r.json(); if (j && j.token) localStorage.setItem('cepi.jwt', j.token);
        }, { email: t.email, pass: PASS });
      } catch { /* best-effort */ }
    }
    console.log('[bot] keep-alive: tokens renovados');
  }, 40 * 60 * 1000);
}

function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); }

async function act(role, p, a) {
  switch (a.do) {
    case 'goto':   await p.goto(String(a.url).startsWith('http') ? a.url : FRONTEND + a.url, { waitUntil: 'domcontentloaded' }); break;
    case 'click':
      if (a.sel) await p.click(a.sel, { timeout: 8000 });
      else await p.getByText(a.text, { exact: !!a.exact }).first().click({ timeout: 8000 });
      break;
    case 'fill':   await p.fill(a.sel, a.text); if (a.submit) await p.keyboard.press('Enter'); break;
    case 'press':  await p.keyboard.press(a.key); break;
    case 'reload': {                              // recarga RE-LOGUEANDO (el JWT puede haber expirado)
      const t = targets.find(x => x.role === role);
      if (t) await login(p, t); else await p.reload({ waitUntil: 'domcontentloaded' });
      break;
    }
    case 'relogin': {
      const t = targets.find(x => x.role === role);
      return { ok: t ? await login(p, t) : false };
    }
    case 'text':   return { url: p.url(), text: (await p.evaluate(() => document.body.innerText)).replace(/\n{3,}/g, '\n\n').slice(0, 6000) };
    case 'eval':   return { result: await p.evaluate(a.fn) };
    case 'console':return { logs: logs[role] || [] };
    case 'shot': {
      const f = path.join(SHOTS, role + '.png');
      await p.screenshot({ path: f, fullPage: !!a.fullPage });
      return { shot: f };
    }
    default: throw new Error('accion desconocida: ' + a.do);
  }
  await p.waitForTimeout(a.wait != null ? a.wait : 500);
  return { ok: true, url: p.url() };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.startsWith('/status')) {
      const out = [];
      for (const [role, p] of Object.entries(pages)) {
        out.push({ role, url: p.url(), title: await p.title().catch(() => ''), errors: (logs[role] || []).filter(l => l.type === 'pageerror' || l.type === 'error').length });
      }
      return json(res, 200, { ok: true, frontend: FRONTEND, windows: out });
    }
    if (req.method === 'POST' && req.url.startsWith('/act')) {
      const a = JSON.parse(await readBody(req) || '{}');
      const p = pages[a.role];
      if (!p) return json(res, 404, { ok: false, error: 'rol desconocido: ' + a.role, roles: Object.keys(pages) });
      return json(res, 200, { ok: true, role: a.role, ...(await act(a.role, p, a)) });
    }
    json(res, 404, { ok: false, error: 'GET /status | POST /act {role,do,...}' });
  } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`[bot] el puerto ${PORT} ya está en uso — ¿el bot ya está corriendo?`); process.exit(1); }
  throw e;
});

start().then(() => server.listen(PORT)).catch(e => { console.error('[bot] error al arrancar:', e.message); process.exit(1); });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
