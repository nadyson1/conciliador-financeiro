import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const processEnv = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const repositoryName = processEnv.GITHUB_REPOSITORY?.split('/')[1]
const isGitHubPagesProjectSite = processEnv.GITHUB_ACTIONS === 'true'
  && repositoryName
  && !repositoryName.toLowerCase().endsWith('.github.io')
const base = isGitHubPagesProjectSite ? `/${repositoryName}/` : '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Conciliador Financeiro',
        short_name: 'Conciliador',
        description: 'Conciliação local de despesas registradas e movimentações bancárias.',
        theme_color: '#101214',
        background_color: '#101214',
        display: 'standalone',
        start_url: base,
        scope: base,
        lang: 'pt-BR',
        icons: [
          { src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        clientsClaim: true,
        skipWaiting: false,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: []
      }
    })
  ]
})
