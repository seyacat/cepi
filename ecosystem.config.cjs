/**
 * cepi unified PM2 ecosystem.
 *
 * Phase 1 of the medical-assistant project (PAPER §15) only needs the
 * TodoERP backend + admin frontend up. As later phases land:
 *   Fase 4 → adds `cepi-bot` (the conversational medical agent)
 *           and `cepi-medical-frontend` (the unified medical UI).
 *   Fase 6 → adds the Python ISIC inference service.
 *
 * The MCP server (`TodoERP/mcp`) is stdio-based and is spawned by the
 * agent process, so it does not appear here.
 *
 * The legacy CEPI chatbot at `backend/server.js` is intentionally NOT
 * managed by PM2 anymore; it will be replaced by `cepi-bot` in Fase 4.
 *
 * Windows note: PM2 mishandles `script: 'npm'` on Windows (it tries to
 * parse npm.cmd as JS), so we invoke node directly instead.
 */
module.exports = {
  apps: [
    {
      name: 'todoerp-backend',
      script: 'node',
      args: '--no-warnings=ExperimentalWarning --loader ts-node/esm src/app.ts',
      cwd: './TodoERP/backend',
      watch: false,
      env: {
        NODE_ENV: 'development',
        STAGE: 'DEVELOP',
        PORT: 3001,
      },
      max_memory_restart: '500M',
    },
    {
      name: 'todoerp-frontend',
      script: 'node',
      args: 'node_modules/vite/bin/vite.js --host',
      cwd: './TodoERP/frontend',
      watch: false,
      env: {
        NODE_ENV: 'development',
        VITE_API_URL: 'http://localhost:3001',
      },
      max_memory_restart: '500M',
    },
  ],
};
