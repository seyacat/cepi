FROM node:22-alpine
WORKDIR /app

# Install deps separately for cache reuse.
COPY package*.json ./
RUN npm ci --omit=optional

# TodoERP MCP package needs to be built before bot starts (the bot spawns it).
# We mount it as a sibling at runtime via the compose `build` context.
COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/server.js"]
