FROM node:24-alpine

WORKDIR /app

COPY server ./server
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

EXPOSE 3000

USER node

CMD ["node", "server/index.js"]
