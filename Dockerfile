FROM oven/bun:1-alpine
WORKDIR /app
COPY src/ ./src/
EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
