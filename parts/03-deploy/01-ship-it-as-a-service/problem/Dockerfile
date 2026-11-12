# Starter: copy to employee/Dockerfile. compose.yaml builds it from the repo root, so config/models.ts comes along.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY config/ config/
COPY employee/ employee/
# TODO: make a folder for traces and one for saved jobs, owned by the bun user.
# TODO: set PORT=7701, TRACE_DIR and STATE_DIR with ENV. Never a key.
USER bun
WORKDIR /app/employee
EXPOSE 7701
CMD ["bun", "start.ts"]
