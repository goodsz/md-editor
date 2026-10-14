import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: 'localhost',
  },
  build: {
    // md_kernel.wasm（~12KB）内联为 data URL：?init 加载在
    // 浏览器 / Electron file:// / Node 测试环境均可原生工作
    assetsInlineLimit: 200_000,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
