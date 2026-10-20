import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonOrigin = new URL(process.env.TOKEN_COUPON_WEB_DAEMON_ORIGIN || "http://127.0.0.1:4177");
if (daemonOrigin.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(daemonOrigin.hostname)) {
  throw new Error("web_dev_proxy_forbidden：Vite 开发代理只允许指向本机 daemon");
}

export default defineConfig({
  plugins: [react(), {
    name: "token-coupon-local-session",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "GET" || !["/", "/index.html"].includes((request.url || "/").split("?")[0])) return next();
        try {
          const landing = await fetch(new URL("/", daemonOrigin), { redirect: "error", signal: AbortSignal.timeout(5000) });
          const cookies = landing.headers.getSetCookie().filter(cookie => cookie.startsWith("tc_local=") && /;\s*HttpOnly(?:;|$)/i.test(cookie));
          await landing.body?.cancel();
          if (!landing.ok || !cookies.length) throw new Error("local_session_unavailable");
          response.setHeader("Set-Cookie", cookies);
          response.setHeader("Cache-Control", "no-store");
          next();
        } catch {
          response.statusCode = 503;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("web_dev_daemon_unavailable：无法建立本机授权，请先启动配置的 daemon，再刷新页面。");
        }
      });
    },
  }],
  root: fileURLToPath(new URL("./public/", import.meta.url)),
  resolve: { alias: { "/src": fileURLToPath(new URL("./src/", import.meta.url)) } },
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "react-vendor", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 20 }],
        },
      },
    },
  },
});
