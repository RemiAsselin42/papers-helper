import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Native FS watchers are unreliable on Windows (especially under MSYS / OneDrive
// paths). Polling fixes hot-reload there, but it's wasteful elsewhere.
const isWindows = process.platform === 'win32'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    watch: isWindows ? { usePolling: true, interval: 300 } : undefined,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/**/*.module.scss',
      ],
    },
  },
})
