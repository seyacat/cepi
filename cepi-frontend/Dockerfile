FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=optional

COPY index.html vite.config.js ./
COPY src ./src

EXPOSE 5174
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", "5174"]
