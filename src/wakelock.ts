/**
 * 螢幕恆亮。記分板架在球檯旁時，平板自動休眠會直接毀掉可用性。
 * Wake Lock 在切到背景時會被系統釋放，回到前景要重新取得。
 */
export function createWakeLock() {
  let sentinel: WakeLockSentinel | null = null;
  let wanted = false;

  const supported = 'wakeLock' in navigator;

  async function acquire(): Promise<void> {
    if (!supported || !wanted || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      // 電量過低或未經使用者互動時會被拒絕，靜默失敗即可。
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
  });

  return {
    supported,
    request(): void {
      wanted = true;
      void acquire();
    },
    release(): void {
      wanted = false;
      void sentinel?.release();
      sentinel = null;
    },
  };
}
