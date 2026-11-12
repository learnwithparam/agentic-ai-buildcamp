# The employee's image. Build it from the repo root (compose.yaml sets the context) so config/models.ts comes along.
# A common mistake: the key is passed as a build arg so the image "just works". It is now saved in the image.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY config/ config/
COPY reference/src/ reference/src/
COPY reference/replay/ reference/replay/
COPY reference/policy.yaml reference/policy.yaml
COPY parts/03-deploy/deploy-kit.ts parts/03-deploy/deploy-kit.ts
COPY parts/03-deploy/01-ship-it-as-a-service/wrong/key-baked-into-the-image/employee.toml parts/03-deploy/01-ship-it-as-a-service/wrong/key-baked-into-the-image/start.ts parts/03-deploy/01-ship-it-as-a-service/wrong/key-baked-into-the-image/
# Traces and saved jobs live on volumes, so they outlive the container. The bun user owns them.
RUN mkdir -p /data/traces /data/state && chown -R bun:bun /data
ARG ANTHROPIC_API_KEY
ENV ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
ENV PORT=7701 TRACE_DIR=/data/traces STATE_DIR=/data/state
USER bun
WORKDIR /app/parts/03-deploy/01-ship-it-as-a-service/wrong/key-baked-into-the-image
EXPOSE 7701
CMD ["bun", "start.ts"]
