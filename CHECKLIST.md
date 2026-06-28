# Checklist — sesión de testing telemedicina

Estado: ✅ hecho · 🛠️ en progreso · ⬜ pendiente
(deploy = en prod https://telemedicina.cepi.ec)

## Hilo / chat del paciente
- ✅ Un solo chat por paciente (hilo grupal cross-user con remitente, tipo WhatsApp) — deploy
- ✅ Nombre del remitente en cada mensaje (mío der., otros izq. con nombre, bot 🤖) — deploy
- ✅ Orden cronológico por timestamp de turno — deploy
- ✅ Al abrir el chat, scroll al fondo (último mensaje) — deploy
- ✅ Lista de pacientes reactiva (poll 20s) — las derivaciones aparecen sin refrescar — deploy
- ✅ Lista ordena primero los pacientes derivados a mí (badge "🔔 revisar") — deploy
- ✅ Dropdown "Secciones" de la ficha con ✓ en las llenas → abre form inline de cada una — deploy
- ✅ Botón "Ver ficha" (visor read-only, iframe /ficha.html) — deploy
- ✅ Quitar botón "Cerrar" → "Nueva consulta" (nuevo episodio, cualquier médico) — deploy
- ✅ Navegación por episodios con flechas ‹ › (nueva consulta = página vacía; anteriores solo-lectura; sellado de episode_id por turno) — deploy
- ✅ Toggle "Auto-form" (OFF por defecto): ON pide el siguiente campo faltante; OFF solo el form que abras — deploy
- ✅ Botón "volver" (←) dentro del header del chat (no en el header de página); se quitó "← Pacientes" truncado — deploy
- ✅ browser-bot: `reload` re-loguea + keep-alive (renueva token c/40min) → las sesiones no se desloguean
- ✅ Botón Derivar: opción "⭐ Al responsable del caso" (responsable_actual_id; si no, el creador) — deploy
- ✅ Al crear episodio, no mostrar "Episodio creado (id…)" ni el comando (ruido) — deploy
- ✅ En la card del paciente: quién lo tiene a cargo (responsable→derivado→creador); cambia al derivar (sirve para verificar la derivación) — deploy

- ✅ Ocultar "Consulta general" (scope innecesario) — deploy

- ✅ En mobile las acciones del header van en un burger (☰) para no ensuciar — deploy

## Reglas / backend
- ✅ Aviso 'cambios sin guardar' al cerrar el visor de ficha — deploy
- ✅ Catálogo CIE-10 también limpiado en prod (datos+def+form+nav) — prod

- ✅ Visor de ficha: botón **Guardar** (antes editabas y se descartaba sin aviso) — deploy
- ✅ Eliminado catálogo CIE-10 local (def+form+nav+seed+comando bot); diagnóstico = ICD-11 OMS único — deploy
- ✅ Limpieza de data clínica de prueba (pacientes/episodios/chats/reminders) — local

- ✅ La campana "🔔 revisar" del card mira solo el episodio más reciente del paciente (recordatorios de episodios viejos no la encienden) — deploy
- ✅ Quitar el botón de tema oscuro (siempre tema claro por ahora) — deploy

- ✅ Al derivar/escalar, se completa el recordatorio propio → la campana "revisar" del que reenvía se limpia — deploy
- ✅ Título de la barra: "Telemedicina" (antes "Asistente clínico") — deploy

- ✅ Cerrar episodio: solo el médico responsable o permiso `episode:close` (supermédico) / admin — deploy
- ✅ Campos select (sexo/etnia/etc.): coerción de texto libre a opción válida ("hombre negro" → M/afro) — deploy
- ✅ Bug DeepSeek 400 (role 'tool' sin tool_calls) corregido — deploy
- ✅ El bot indica qué falta de la ficha al abrir el chat — deploy
- ✅ Derivar ejecuta al elegir destino (antes lo escribía en el input) + motivo opcional — deploy

## Entorno / herramientas
- ✅ DeepSeek también en local (provider + key en cepi-bot/.env)
- ✅ browser-bot debugger (scripts/browser-bot/): 6 perfiles por rol, auto-login, API :8899
- ✅ Borrar datos de prueba / tablero en cero para empezar un caso desde cero
