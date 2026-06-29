# cepi browser-bot — debugger multi-perfil

Levanta **una ventana Chrome por rol**, cada una con perfil aislado y
**auto-logueada**, y expone una **API HTTP** para controlarlas. Sirve para
depurar la app desde la perspectiva de cada rol y para que el agente (Claude)
maneje las ventanas por `curl` (el agente no puede lanzar Chrome desde su
sandbox, pero sí controlar el bot por red).

## Arrancar (en TU sesión gráfica, con DISPLAY)

```bash
# como servicio en background:
nohup bash scripts/browser-bot/start.sh > /tmp/cepi-bot.log 2>&1 &
# o en primer plano:
bash scripts/browser-bot/start.sh
# subconjunto de roles / otro frontend / otro puerto:
ROLES=primario,derma1 FRONTEND=http://localhost:5174 PORT=8899 bash scripts/browser-bot/start.sh
```

Abre las ventanas (tiladas) y deja la API en `http://localhost:8899`.
Roles disponibles: `primario derma1 derma2 residente super admin`
(usuarios `*@cepi.local` / `admin@erp.com`, password `Admin123!` — configurable
con `CEPI_PASS`).

## Controlar (CLI)

```bash
scripts/browser-bot/drive.sh status
scripts/browser-bot/drive.sh shot derma1                 # -> scripts/browser-bot/shots/derma1.png
scripts/browser-bot/drive.sh text derma1                 # innerText visible
scripts/browser-bot/drive.sh console residente           # console + errores JS
scripts/browser-bot/drive.sh click primario "Derivar"
scripts/browser-bot/drive.sh fill primario "textarea" "lesión en brazo" true
scripts/browser-bot/drive.sh goto super /#supermedico
scripts/browser-bot/drive.sh eval admin "() => localStorage.getItem('cepi.jwt')"
```

## API HTTP

- `GET /status` → `{ windows:[{role,url,title,errors}] }`
- `POST /act {role, do, ...}`:
  - `goto {url}` · `reload`
  - `click {text}` o `click {sel}` (opcional `exact:true`)
  - `fill {sel, text, submit?}` · `press {key}`
  - `text` → innerText · `console` → buffer de console/pageerror
  - `eval {fn}` → ejecuta la función en la página y devuelve el resultado
  - `shot {fullPage?}` → guarda `shots/<rol>.png`

## Notas
- Necesita `playwright-core` (ya está en `node_modules`) + Chrome instalado.
- Las ventanas son tu Chrome real: podés clickear a mano además de por la API.
- `shots/` y `*.log` están gitignored.
- Detener: `pkill -f browser-bot/bot.cjs` (cierra las ventanas).
