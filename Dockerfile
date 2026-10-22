# FriendSplit – Node.js ohne Zusatzpakete. Läuft als unprivilegierter Benutzer „node“.
FROM node:24-alpine

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_FILE=/data/friendsplit.sqlite

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:3000/api?action=health" > /dev/null || exit 1

CMD ["node", "server/main.js"]
