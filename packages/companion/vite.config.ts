import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 前端根是 web/，构建产物也落在 web/dist —— 服务端在非开发模式下就从这里取静态文件。
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 浏览器只跟 Vite 说话；/api 由它转给本地 Node 服务，免得额外配 CORS。
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./web/dist', import.meta.url)),
    emptyOutDir: true,
  },
});
