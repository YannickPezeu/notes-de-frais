FROM node:22-alpine
WORKDIR /app
# Aucune dépendance npm : seuls le serveur et les fichiers servis sont copiés.
COPY server/ server/
COPY web/ web/
USER node
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/server.mjs"]
