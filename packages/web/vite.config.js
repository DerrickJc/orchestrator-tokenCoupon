import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const daemonOrigin = new URL(process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN || "http://127.0.0.1:4177");
if (daemonOrigin.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(daemonOrigin.hostname)) {
  throw new Error("web_dev_proxy_forbidden：Vite 开发代理只允许指向本机 daemon");
}

export default defineConfig({
  root: fileURLToPath(new URL("./public/", import.meta.url)),
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: daemonOrigin.origin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", request => request.setHeader("origin", daemonOrigin.origin));
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/", import.meta.url)),
    emptyOutDir: true,
    manifest: true,
  },
});
