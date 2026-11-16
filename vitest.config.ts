import path from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Node 25+ ships a global localStorage that is undefined without
    // --localstorage-file and shadows jsdom's, so turn it off in test workers.
    execArgv:
      Number(process.versions.node.split('.')[0]) >= 25
        ? ['--no-experimental-webstorage']
        : [],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
