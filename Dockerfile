FROM node:22-alpine
WORKDIR /app
COPY sidecar/package*.json ./
RUN npm ci --omit=dev
COPY sidecar/ ./
ENV NEUROCODE_PORT=39291
EXPOSE 39291
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:39291/health || exit 1
CMD ["node", "server.js"]
