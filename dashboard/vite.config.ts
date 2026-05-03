import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      "/api/left": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/left/, "")
      },
      "/api/right": {
        target: "http://127.0.0.1:8083",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/right/, "")
      },
      "/api/memory": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/memory/, "")
      }
    }
  }
});
