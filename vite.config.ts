// First, so ALICE_* settings are filled from BAKERY_* ones before anything reads them.
import "./server/legacy-names.ts";
import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFeatures } from "./src/features.js";
// ALICE_API_TARGET points the dev UI at another Alice server, e.g. a remote one over Tailscale.
const apiTarget = process.env.ALICE_API_TARGET ?? "http://127.0.0.1:4317";
// The optional features are baked into the UI here (src/features.ts). A bad switch value fails the build.
const features = JSON.stringify(readFeatures(process.env));
// node_modules may be a symlink to another checkout's, so allow its real path too.
export default defineConfig({ plugins: [react(), tailwindcss()], define: { __ALICE_FEATURES__: features }, server: { host: "127.0.0.1", port: Number(process.env.ALICE_VITE_PORT ?? 5173), strictPort: true, fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync("node_modules")] }, proxy: { "/api": { target: apiTarget, changeOrigin: true, configure: proxy => proxy.on("proxyReq", (request, incoming) => { if (request.getHeader("origin") === `http://${incoming.headers.host}`) request.setHeader("origin", new URL(apiTarget).origin); }) } } } });
