/// <reference types="vite-plugin-pwa/client" />

/** 建置時間，由 vite.config.ts 的 define 注入，用來讓使用者確認版本。 */
declare const __BUILD_ID__: string;
