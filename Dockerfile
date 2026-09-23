FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
COPY ui ./ui
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build && chown -R node:node /app
USER node
EXPOSE 4310
CMD ["npm", "start"]
