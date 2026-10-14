FROM node:24-alpine

WORKDIR /app

COPY server ./server
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/data
ENV NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

# node:sqlite is stable enough for our use; hide its experimental-feature banner.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
