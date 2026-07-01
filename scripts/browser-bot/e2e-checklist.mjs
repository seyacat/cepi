#!/usr/bin/env node
// e2e-checklist.mjs — valida vía el browser-bot (:8899) toda la lista de features
// implementadas en la sesión. Corre secuencial (el bot es un recurso único).
//   node scripts/browser-bot/e2e-checklist.mjs
const BOT = process.env.BOT || 'http://localhost:8899';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function act(role, extra) {
  const res = await fetch(`${BOT}/act`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, ...extra }),
  });
  return res.json();
}
const ev = async (role, expr) => (await act(role, { do: 'eval', fn: expr })).result;
const reload = async (role) => { await act(role, { do: 'reload' }); await sleep(1800); };
const click = (role, sel) => act(role, { do: 'click', sel });
const clickText = (role, text) => act(role, { do: 'click', text });

// helper de fetch autenticado dentro de la página (usa el JWT de la sesión)
const AF = (path, opts = 'null') =>
  `fetch("${path}",Object.assign({headers:{Authorization:"Bearer "+localStorage.getItem("cepi.jwt"),"Content-Type":"application/json"}},${opts})).then(r=>r.json())`;

const results = [];
const check = (id, name, pass, info = '') => { results.push({ id, name, pass: !!pass, info }); const m = pass ? 'PASS' : 'FAIL'; console.log(`${pass ? '✅' : '❌'} [${id}] ${name}${info ? '  — ' + info : ''}`); };
const T = (v) => JSON.stringify(v);

// abre el menú burger del topbar y devuelve los labels de sus botones
async function topMenuLabels(role) {
  await click(role, '.top-burger'); await sleep(500);
  return ev(role, `(()=>[...document.querySelectorAll(".topbar .user button")].map(b=>b.textContent.trim()))()`);
}
async function clickTopMenu(role, label) {
  await click(role, '.top-burger'); await sleep(400);
  return ev(role, `(()=>{const b=[...document.querySelectorAll(".topbar .user button")].find(x=>x.textContent.trim()===${T(label)}); if(b){b.click();return true;} return false;})()`);
}

async function main() {
  // ── Seed / orgs (#3) ──────────────────────────────────────────────────────
  await reload('primario');
  const primOrgs = await ev('primario', `${AF('/api/orgs')}.then(j=>(j.orgs||[]).map(o=>o.slug).sort())`);
  check('#3a', 'primario en 2 orgs (cepi + cepi-testing)', Array.isArray(primOrgs) && primOrgs.length === 2 && primOrgs.includes('cepi') && primOrgs.includes('cepi-testing'), T(primOrgs));

  await reload('derma1');
  const d1Orgs = await ev('derma1', `${AF('/api/orgs')}.then(j=>(j.orgs||[]).map(o=>o.slug))`);
  check('#3b', 'derma1 solo en cepi-testing', Array.isArray(d1Orgs) && d1Orgs.length === 1 && d1Orgs[0] === 'cepi-testing', T(d1Orgs));

  await reload('admin');
  const users = await ev('admin', `${AF('/api/admin/users')}.then(j=>j.users||[])`);
  const emails = (users || []).map(u => u.email);
  check('#3c', 'super@cepi.local existe (seed)', emails.includes('super@cepi.local'), `${emails.length} usuarios`);

  // ── Org assignment / editor (#2 #20 #21) ─────────────────────────────────
  check('#21', 'AdminOrgs usa /api/admin/users (no security vacío)', (users || []).length >= 6, `${(users || []).length} usuarios`);
  check('#2', 'usuarios traen org_ids (chips de org)', (users || []).every(u => Array.isArray(u.org_ids)), '');

  // ── Cédulas serializadas (#19) ────────────────────────────────────────────
  const ceds = await ev('primario', `${AF('/api/entities?type=business&entity_id=11000000-0000-0000-0000-000000000000&limit=500')}.then(j=>(j.data||[]).map(p=>p.data&&p.data.cedula).filter(Boolean))`);
  check('#19', 'cédulas serializadas de 10 dígitos', Array.isArray(ceds) && ceds.length > 0 && ceds.every(c => /^\d{10}$/.test(c)), T((ceds || []).slice(0, 3)));

  // ── Perfil propio PATCH /me (#7) ──────────────────────────────────────────
  const patched = await ev('primario', `${AF('/api/auth/me', '{method:"PATCH",body:JSON.stringify({phone:"0990001122"})}')}.then(j=>j.user&&j.user.phone)`);
  check('#7', 'PATCH /api/auth/me actualiza el perfil', patched === '0990001122', `phone=${patched}`);

  // ── Derivación en el card (#18) ───────────────────────────────────────────
  const pa = await ev('primario', `${AF('/api/patient-assignments')}.then(j=>Object.values(j.assignments||{}))`);
  const grp = (pa || []).filter(a => a.source === 'derivado_grupo' && a.assignee_name);
  const nulls = (pa || []).filter(a => !a.assignee_name);
  check('#18a', 'card muestra nombre de grupo al derivar a círculo', grp.length > 0, grp.map(g => g.assignee_name).join(', '));
  check('#18b', 'ningún card queda sin derivado (creador=primer derivado)', (pa || []).length > 0 && nulls.length === 0, `${nulls.length} nulls`);

  // ── Notificaciones scoped al usuario (#23) ────────────────────────────────
  await reload('super');
  const scope = await ev('super', `(async()=>{const t=localStorage.getItem("cepi.jwt");const sub=JSON.parse(atob(t.split(".")[1])).sub;const [a,b]=await Promise.all([${AF('/api/reminders')},${AF('/api/reminders?owner_user_id="+sub+"')}]);return {all:(a.data||[]).length, mine:(b.data||[]).length};})()`);
  check('#23', 'campana scoped (super no ve ajenas)', scope && scope.mine <= scope.all && scope.mine === 0, `all=${scope && scope.all} mine=${scope && scope.mine}`);
  const superBadge = await ev('super', `(()=>document.querySelector(".notif-count")?document.querySelector(".notif-count").textContent:"0")()`);
  check('#23b', 'badge de super = 0', superBadge === '0', `badge=${superBadge}`);

  // ── Notificación: paciente + médico que deriva (#24) ─────────────────────
  await reload('derma1');
  const nfmt = await ev('derma1', `(async()=>{const t=localStorage.getItem("cepi.jwt");const sub=JSON.parse(atob(t.split(".")[1])).sub;const j=await ${AF('/api/reminders?owner_user_id="+sub+"')};const rows=j.data||[];if(!rows.length)return {n:0};const r=rows[0];let pn=null;try{const pr=await ${AF('/api/review-queue/patient/"+r.entity_id+"')};pn=pr.patient_name;}catch(e){}return {n:rows.length, created_by_name:r.created_by_name, patient_name:pn};})()`);
  check('#24a', 'reminder trae created_by_name (médico que deriva)', nfmt && nfmt.n > 0 && !!nfmt.created_by_name, `deriva=${nfmt && nfmt.created_by_name}`);
  check('#24b', 'resolver de reminder → nombre del paciente', nfmt && !!nfmt.patient_name, `paciente=${nfmt && nfmt.patient_name}`);

  // ── Campana fuera del burger + spacing (#17 #22) ──────────────────────────
  await reload('primario');
  const bellOut = await ev('primario', `(()=>{const hr=document.querySelector(".header-right"); const bell=hr&&hr.querySelector(":scope > .notif"); const gap=hr?getComputedStyle(hr).gap:"0px"; return {outside:!!bell, gap};})()`);
  check('#17', 'campana fuera del burger (hija directa de header-right)', bellOut && bellOut.outside, '');
  check('#22', 'header-right tiene gap (campana con espacio)', bellOut && bellOut.gap && bellOut.gap !== '0px' && bellOut.gap !== 'normal', `gap=${bellOut && bellOut.gap}`);

  // ── Un solo burger a la vez + lista (#5 #6 #10) ───────────────────────────
  await reload('primario');
  const listState = await ev('primario', `(()=>({top:!!document.querySelector(".top-burger"), chat:!!(document.querySelector(".ihead-burger")&&document.querySelector(".ihead-burger").offsetParent)}))()`);
  check('#5/#6a', 'lista: burger del topbar visible, del chat no', listState.top && !listState.chat, T(listState));

  await clickText('primario', 'Pepita Peres'); await sleep(2200);
  const chatState = await ev('primario', `(()=>({top:!!document.querySelector(".top-burger"), chat:!!(document.querySelector(".ihead-burger")&&document.querySelector(".ihead-burger").offsetParent), name:document.querySelector(".ihead-name")?.textContent?.trim()}))()`);
  check('#6b', 'paciente abierto: burger del chat sí, del topbar no', !chatState.top && chatState.chat, T({ top: chatState.top, chat: chatState.chat }));

  // ── Ack filter (#8) ───────────────────────────────────────────────────────
  const ackCount = await ev('primario', `(()=>[...document.querySelectorAll(".iturn.assistant")].filter(e=>/^\\s*Paciente activo:/.test(e.textContent.replace(/^🤖 Asistente/,""))).length)()`);
  check('#8', 'ack "Paciente activo" aparece ≤1 vez', typeof ackCount === 'number' && ackCount <= 1, `count=${ackCount}`);

  // ── Blur close del burger del chat (#15) ─────────────────────────────────
  await click('primario', '.ihead-burger'); await sleep(500);
  const opened = await ev('primario', `(()=>!!document.querySelector(".ihead-actions.open"))()`);
  await click('primario', '.ifeed'); await sleep(500);
  const closed = await ev('primario', `(()=>!document.querySelector(".ihead-actions.open"))()`);
  check('#15', 'burger del chat cierra por blur (click afuera)', opened && closed, `abrió=${opened} cerró=${closed}`);

  // ── Auto per-chat + trigger inmediato (#16) ──────────────────────────────
  await click('primario', '.ihead-burger'); await sleep(400);
  await click('primario', '.autoform-toggle'); await sleep(2200);
  const auto = await ev('primario', `(()=>({on:!!document.querySelector(".autoform-toggle.on"), form:!!document.querySelector(".iform"), perChat:Object.keys(localStorage).some(k=>/^cepi\\.autoform\\.[0-9a-f-]{8,}/.test(k))}))()`);
  check('#16a', 'auto ON dispara la siguiente sección (form visible)', auto.on && auto.form, T({ on: auto.on, form: auto.form }));
  check('#16b', 'auto es per-chat (clave localStorage por paciente)', auto.perChat, '');

  // ── Volver al chat restaura el burger del topbar (#10) ────────────────────
  await click('primario', '.ihead-back'); await sleep(1200);
  const backState = await ev('primario', `(()=>!!document.querySelector(".top-burger"))()`);
  check('#10', 'al volver del chat reaparece el burger del topbar', backState, '');

  // ── Menú: Perfil en chat, sin Volver (#9 #11) ────────────────────────────
  await reload('primario');
  const chatMenu = await topMenuLabels('primario');
  check('#11', 'menú en chat: sin "Volver"', Array.isArray(chatMenu) && !chatMenu.includes('Volver'), T(chatMenu));
  check('#9a', 'menú tiene "Perfil"', Array.isArray(chatMenu) && chatMenu.some(l => l.includes('Perfil')), '');

  // ── Perfil: Logout + volver (#7ui #9) ────────────────────────────────────
  await clickTopMenu('primario', '👤 Perfil'); await sleep(1200);
  const prof = await ev('primario', `(()=>({title:document.querySelector(".prof h2")?.textContent, logout:!!document.querySelector(".prof-logout-btn"), email:!!document.querySelector(".prof-field input[disabled]")}))()`);
  check('#7ui', 'página de perfil (título + email readonly)', prof && /perfil/i.test(prof.title || '') && prof.email, T(prof.title));
  check('#9b', 'perfil tiene botón Logout', prof && prof.logout, '');
  // en perfil, el menú debe mostrar "Volver"
  const profMenu = await topMenuLabels('primario');
  check('#9c', 'menú en Perfil: muestra "Volver"', Array.isArray(profMenu) && profMenu.includes('Volver'), T(profMenu));

  // ── Admin: menú Volver, sin Chat; Usuarios full width + buscador (#12 #13 #4) ─
  await reload('admin');
  await clickTopMenu('admin', 'Admin'); await sleep(1800);
  const adminMenu = await topMenuLabels('admin');
  check('#12', 'menú en Admin: "Volver", sin "Chat"', Array.isArray(adminMenu) && adminMenu.includes('Volver') && !adminMenu.includes('Chat'), T(adminMenu));
  // cerrar menú
  await ev('admin', `(()=>{const b=document.querySelector(".top-burger"); if(document.querySelector(".topbar .user.open"))b&&b.click(); return 1;})()`); await sleep(400);
  const width = await ev('admin', `(()=>{const a=document.querySelector(".admin"); return a?getComputedStyle(a).maxWidth:"?";})()`);
  check('#13', 'Usuarios usa todo el ancho (max-width:none)', width === 'none', `max-width=${width}`);
  // buscador: filtro por texto inexistente → 0 filas
  const search = await ev('admin', `(()=>{const s=document.querySelector(".admin select"); if(s){s.value=""; s.dispatchEvent(new Event("change"));} return !!document.querySelector(".admin .search");})()`);
  await sleep(1500);
  const searchWorks = await ev('admin', `(async()=>{const inp=document.querySelector(".admin .search"); if(!inp)return {no:true}; const before=document.querySelectorAll(".admin tbody tr").length; inp.value="zzz_nomatch_xyz"; inp.dispatchEvent(new Event("input")); await new Promise(r=>setTimeout(r,300)); const after=document.querySelectorAll(".admin tbody tr").length; inp.value=""; inp.dispatchEvent(new Event("input")); return {before, after};})()`);
  check('#4', 'buscador de Usuarios filtra (nombre/cédula/rol)', search && searchWorks && searchWorks.before > 0 && searchWorks.after === 0, T(searchWorks));

  // ── Notificación clickeable → abre el chat (#14) ─────────────────────────
  await reload('derma1');
  await click('derma1', '.notif-bell'); await sleep(1200);
  await click('derma1', '.notif-item.clickable'); await sleep(2500);
  const opened14 = await ev('derma1', `(()=>document.querySelector(".ihead-name")?.textContent?.trim()||null)()`);
  check('#14', 'click en notificación abre el chat del paciente', !!opened14, `abrió=${opened14}`);

  // ── Resumen ────────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.pass).length, fail = results.length - pass;
  console.log('\n' + '='.repeat(60));
  console.log(`RESULTADO E2E: ${pass}/${results.length} PASS, ${fail} FAIL`);
  if (fail) { console.log('\nFALLOS:'); results.filter(r => !r.pass).forEach(r => console.log(`  ❌ [${r.id}] ${r.name} — ${r.info}`)); }
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERROR e2e:', e); process.exit(2); });
