import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 纯浏览器开发模式（pnpm dev:web）：无 Electron 桥，renderer 自动回落到 mock API
// 端口：优先用预览系统分配的 PORT 环境变量，否则默认 5173
const port = Number(process.env.PORT) || 5173

export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  plugins: [react()],
  server: { port, strictPort: false }
})
