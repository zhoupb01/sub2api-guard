import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.GUARD_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": backend, "/login": backend, "/logout": backend },
  },
});
