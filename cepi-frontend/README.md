# cepi-frontend

UI de chat para el asistente médico de cepi (PAPER §12 / Fase 4).

Vue 3 + Vite, sin librerías de UI extras — un App + Login + Chat +
ToolResult son los únicos componentes. Toda la lógica del agente vive
en `cepi-bot/`; este frontend solo es presentación.

## Run

```bash
npm install
npm run dev   # vite en :5174
```

El servidor de Vite proxea `/api/auth` y `/api/entities` a TodoERP
(`:3001`) y `/api/bot` a `cepi-bot` (`:3002`). En producción se
reemplaza el proxy por un reverse-proxy que enrute por path.

## Atajos del side panel

| Botón | Comando enviado al bot |
|---|---|
| /help | `/help` |
| whoami | `whoami` |
| definitions | `definitions` |
| pacientes / episodios / diagnósticos | `entities.list` por slug |
| revisiones | episodes con `estado=en_revisión_solicitada` |
| recordatorios | `reminders.list` pending |
| cie10 melanoma | `entities.list` sobre `icd10_code` |
| ver paciente / ver episodio | `entities.get` del activo |
| casos similares | `vectors.search` sobre la última imagen del episodio |
| sugerir dx | `classifications.list` + mapeo CIE-10 |
| ver chatter | `chatter.list` del activo |
| resumen paciente | conteos rápidos del paciente activo |
| ⤓ exportar | bundle JSON del paciente |
| bandeja revisión | episodios `en_revisión_solicitada` |

## Comandos manuales (composer)

Ver el `/help` desde dentro del chat para la lista actualizada. Los más útiles:

- `activar paciente <uuid>` / `salir paciente`
- `nuevo episodio <motivo>` (gate)
- `cerrar episodio YYYY-MM-DD <motivo>` (gate)
- `diagnostico C43.9 melanoma` (gate)
- `signs PA=120/80 FC=70 T=36.5` (gate)
- `nota <texto>`
- `/escalar a <user-uuid> <razón>` (gate)
- `exportar [anonimizado]`

## Sesión

`cepi.session_id` en `localStorage` mantiene la sesión entre recargas;
al montar el componente Chat se hidrata desde `/api/bot/session/:id`.
"Iniciar otra sesión" la limpia.

## Tema

Toggle ☾/☀ en la barra superior. Persiste en `localStorage.cepi.theme`.

## Adjuntar imagen

Dos modos:
1. Click en el 📎 al lado de Enviar.
2. Drag-and-drop sobre el panel principal del chat.

Si hay paciente y episodio activos al enviar, el bot stagea la
creación de un `clinical_image` ligado al episodio. Confirmás con sí.
Después, el worker ISIC (si está corriendo) calcula embeddings y
clasificaciones que `casos similares` y `sugerir dx` consumen.
