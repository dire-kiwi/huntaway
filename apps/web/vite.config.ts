import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const server = process.env.IA_SERVER ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  // The Changes tab's highlighter worker fetches its grammars as chunks of their own.
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, ws: true, changeOrigin: true },
    },
  },
});
