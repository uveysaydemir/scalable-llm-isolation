import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function edgeProxy(target: string, prefix: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(new RegExp(`^${prefix}`), ""),
    configure: (proxy: import("http-proxy").Server) => {
      // Strip accept-encoding so the upstream never sends compressed responses,
      // which would buffer SSE frames instead of flushing them immediately.
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("accept-encoding");
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      "/api/left": edgeProxy("http://127.0.0.1:8080", "/api/left"),
      "/api/right": edgeProxy("http://127.0.0.1:8083", "/api/right"),
      "/api/memory": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/memory/, ""),
      },
    },
  },
});
