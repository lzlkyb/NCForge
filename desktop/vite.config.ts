// defineConfig 从 vitest/config 导入：vite 的 UserConfig 类型没有 test 字段，
// 用 vite 自家的 defineConfig 写 test 段会被 tsc 当成未知属性拦下。
// vitest/config 是 vite defineConfig 的超集（含 test 类型），vite 构建无感知。
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // E-P2-6: 代码分割——vendor 拆离主 bundle
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-tauri": ["@tauri-apps/api"],
        },
      },
    },
  },
  // vitest 只扫 src/：scripts/ 下是 node:test 范式（check-motion.mjs、
  // lib/zip-store.test.mjs），由 `node --test` 跑（npm run motion:check /
  // test:scripts）。vitest 的默认通配 **/*.test.* 会把它们扫进来，node:test
  // 的用例在 vitest 眼里是「No test suite found」——整批门禁红，但跟业务代码
  // 毫无关系（2026-10-29 实测踩到）。
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
