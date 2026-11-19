FROM oven/bun:1-alpine
WORKDIR /app
COPY src/ ./src/
CMD ["bun", "run", "src/main.ts"]
