/**
 * PWA 版本更新。
 *
 * registerType 用 'prompt' 而不是 'autoUpdate'：套用新版一定要重新載入頁面，
 * 而比賽打到一半被重新載入是不能接受的，所以「什麼時候套用」交給呼叫端決定。
 * 這支只負責偵測與下載。
 */
import { registerSW } from 'virtual:pwa-register';

export interface Updater {
  readonly supported: boolean;
  /** 新版已經下載完，等著套用。 */
  readonly ready: boolean;
  readonly checking: boolean;
  /** 上一次成功詢問伺服器的時間；沒問過為 0。 */
  readonly lastCheckedAt: number;
  /** 主動問一次。force 會略過節流。回傳是否真的送出了請求。 */
  check(force?: boolean): Promise<boolean>;
  /** 套用新版並重新載入頁面。 */
  apply(): void;
  onChange: (() => void) | null;
}

/** 節流：短時間內重複詢問沒有意義，也省得背景切換時狂打。 */
const MIN_INTERVAL_MS = 60_000;
/** 長時間開著不動時的定期詢問。記分板常常整天掛在球檯旁。 */
const POLL_MS = 30 * 60_000;

export function createUpdater(): Updater {
  let registration: ServiceWorkerRegistration | null = null;
  let ready = false;
  let checking = false;
  let lastCheckedAt = 0;
  let onChange: (() => void) | null = null;

  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  const emit = (): void => onChange?.();

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true;
      emit();
    },
    onRegisteredSW(_url, reg) {
      registration = reg ?? null;
      lastCheckedAt = Date.now();
      emit();
      if (!registration) return;

      // 進入 App 時已經由 registerSW 問過一次，這裡補的是「App 沒有被重新
      // 載入」的情境：從背景切回前景、網路重新連上、以及整天掛著不動。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void check();
      });
      window.addEventListener('online', () => void check());
      window.setInterval(() => void check(), POLL_MS);
    },
  });

  async function check(force = false): Promise<boolean> {
    if (!registration || checking || ready) return false;
    if (!force && Date.now() - lastCheckedAt < MIN_INTERVAL_MS) return false;
    checking = true;
    emit();
    try {
      await registration.update();
      lastCheckedAt = Date.now();
      return true;
    } catch {
      // 離線或 sw.js 拿不到都會走到這裡，不是錯誤狀態，下次再問就好。
      return false;
    } finally {
      checking = false;
      emit();
    }
  }

  return {
    supported,
    get ready() {
      return ready;
    },
    get checking() {
      return checking;
    },
    get lastCheckedAt() {
      return lastCheckedAt;
    },
    check,
    apply: () => updateSW(true),
    get onChange() {
      return onChange;
    },
    set onChange(fn: (() => void) | null) {
      onChange = fn;
    },
  };
}
