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
- ✅ Toggle "Auto-form" junto a Secciones: ON sigue pidiendo el siguiente campo faltante; OFF solo muestra el form que abras — deploy
- ✅ Botón "volver" (←) dentro del header del chat (no en el header de página); se quitó "← Pacientes" truncado — deploy
- ✅ browser-bot: `reload` re-loguea + keep-alive (renueva token c/40min) → las sesiones no se desloguean
- ✅ Botón Derivar: opción "⭐ Al responsable del caso" (responsable_actual_id; si no, el creador) — deploy
- ✅ Al crear episodio, no mostrar "Episodio creado (id…)" ni el comando (ruido) — deploy
- ⬜ En la card del paciente, mostrar a quién está derivado cada paciente

- ✅ Ocultar "Consulta general" (scope innecesario) — deploy

## Reglas / backend
- ✅ Cerrar episodio: solo el médico responsable o permiso `episode:close` (supermédico) / admin — deploy
- ✅ Campos select (sexo/etnia/etc.): coerción de texto libre a opción válida ("hombre negro" → M/afro) — deploy
- ✅ Bug DeepSeek 400 (role 'tool' sin tool_calls) corregido — deploy
- ✅ El bot indica qué falta de la ficha al abrir el chat — deploy
- ✅ Derivar ejecuta al elegir destino (antes lo escribía en el input) + motivo opcional — deploy

## Entorno / herramientas
- ✅ DeepSeek también en local (provider + key en cepi-bot/.env)
- ✅ browser-bot debugger (scripts/browser-bot/): 6 perfiles por rol, auto-login, API :8899
- ✅ Borrar datos de prueba / tablero en cero para empezar un caso desde cero
