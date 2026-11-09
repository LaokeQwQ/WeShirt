import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'frontend',
  publicDir: '../public',
  plugins: [vue()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 首屏只加载 index + vant，three.js 留在 Room3D 的懒加载块里。
    // 手动分包的好处：three / vant 版本不常变，用户第二次进来直接命中缓存，
    // 不会因为我们改了业务代码就整包重新下载。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('three')) return 'three'
          if (id.includes('vant') || id.includes('@vant')) return 'vant'
          if (id.includes('vue') || id.includes('pinia')) return 'vue'
        },
      },
    },
    // three 单块本身就有 ~600KB，阈值调到 700 免得每次构建都刷警告
    chunkSizeWarningLimit: 700,
  },
})
