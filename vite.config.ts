import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 會把站台放在 https://<帳號>.github.io/<repo 名稱>/ 底下，
// base 必須與 repo 名稱一致，否則所有資源都會 404。
const REPO = 'pingpong-scoreboard';

// 讓使用者在設定裡看得到自己跑的是哪一版，也方便回報問題。
const BUILD_ID = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export default defineConfig(({ command, isPreview }) => ({
  // 開發時掛在根目錄，正式建置時才加上 repo 路徑。
  // vite preview 的 command 是 'serve'，但它服務的是 build 產物，
  // base 必須跟著 build 走，否則預覽站的資源全部 404。
  base: command === 'build' || isPreview ? `/${REPO}/` : '/',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
  },
  plugins: [
    VitePWA({
      // 套用新版一定要重新載入頁面，比賽中被重新載入不能接受，
      // 因此不用 autoUpdate，改由 src/pwa.ts 決定套用時機。
      registerType: 'prompt',
      injectRegister: null,
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
