FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /data/uploads && chown -R node:node /app /data/uploads

USER node

ENV HOST=0.0.0.0 \
    PORT=5000 \
    NODE_ENV=production \
    UPLOAD_DIR=/data/uploads

EXPOSE 5000

CMD ["node", "server.js"]
