# Lesson 12. The code-evaluator executor Langfuse calls (LANGFUSE_CODE_EVAL_DISPATCHER=external).
# Built by langfuse/workshop.override.yml. Node 24 runs the .ts files directly.
FROM node:24.22.3-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY sandbox.ts server.ts worker.ts ./
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.ts"]
