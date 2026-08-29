import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function repositoryCommit() {
  const suppliedCommit = process.env.IRAP_IMPLEMENTATION_COMMIT?.trim()
  if (suppliedCommit && /^[0-9a-f]{40,64}$/.test(suppliedCommit)) return suppliedCommit
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'working-tree-uncommitted'
  }
}

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ap': 'http://127.0.0.1:8787',
      '/.well-known': 'http://127.0.0.1:8787',
      '/nodeinfo': 'http://127.0.0.1:8787',
    },
  },
  define: {
    __IRAP_IMPLEMENTATION_COMMIT__: JSON.stringify(repositoryCommit()),
  },
})
