FROM oven/bun:1-alpine AS web-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./web/
COPY src/ ./src/
COPY tsconfig.json ./
RUN bunx vite build --config web/vite.config.ts

FROM oven/bun:1-alpine
WORKDIR /app
COPY src/ ./src/
COPY --from=web-build /app/web/dist/ ./web/dist/
EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
