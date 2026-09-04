import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 會把站台放在 https://<帳號>.github.io/<repo 名稱>/ 底下，
// base 必須與 repo 名稱一致，否則所有資源都會 404。
const REPO = 'pingpong-scoreboard';

export default defineConfig(({ command }) => ({
  // 開發時掛在根目錄，正式建置時才加上 repo 路徑。
  base: command === 'build' ? `/${REPO}/` : '/',
  build: {
    target: 'es2022',
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
      manifest: {
        name: '乒乓球記分板',
        short_name: '記分板',
        description: '符合 ITTF 規則的乒乓球記分板，支援語音播報與語音計分。',
        lang: 'zh-Hant-TW',
        start_url: '.',
        scope: '.',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#050506',
        theme_color: '#050506',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
    }),
  ],
}));
