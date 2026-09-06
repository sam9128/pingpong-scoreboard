/**
 * 耳機媒體鍵計分。
 *
 * 耳機的上／下一曲不是鍵盤事件，收不到 keydown —— 它走 AVRCP 到系統，
 * 再交給「目前持有音訊焦點」的那個 App。網頁這一端的入口是 Media Session：
 *
 *   W3C Media Session §2.2：使用者代理應讓使用者知道這些動作會被路由到
 *   持有 active media session 的網站，especially when the actions are
 *   coming from remote devices such as a headset。
 *
 * 代價是必須整場播著音訊才拿得到音訊焦點：
 *
 *   規格：a browsing context has audio focus if it is currently playing audio。
 *   Chrome 文件：Chrome for Android 只有在媒體長度 >= 5 秒時才會要求 full
 *   audio focus。
 *
 * 因此這裡用一段執行時產生、長度 8 秒、振幅低到聽不見但不是數位全靜音的
 * WAV 循環播放。全靜音有機會被判定成沒有在發聲而拿不到焦點。
 *
 * 已知的取捨（無法從網頁端解決）：藍牙耳機本身是音訊輸出裝置，連上之後
 * 語音播報也會被路由到耳機，平板喇叭不會出聲。
 */

export type MediaKeyAction = 'left' | 'right';

export interface MediaKeysOptions {
  onAction: (action: MediaKeyAction) => void;
  onStatus: (status: { active: boolean; message?: string }) => void;
}

/** Chrome for Android 要求媒體長度 >= 5 秒才給 full audio focus，這裡取 8 秒。 */
const LOOP_SECONDS = 8;
const SAMPLE_RATE = 8000;
/** play() 被擋下後的重試間隔，避免失敗時空轉。 */
const RETRY_MS = 800;

export class MediaKeyScorer {
  readonly supported: boolean;

  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private wanted = false;
  private retryTimer: number | null = null;

  constructor(private opts: MediaKeysOptions) {
    this.supported =
      typeof navigator !== 'undefined' &&
      'mediaSession' in navigator &&
      typeof navigator.mediaSession?.setActionHandler === 'function';
  }

  get active(): boolean {
    return this.wanted;
  }

  /** 必須在使用者手勢中呼叫，否則 play() 會被自動播放政策擋下。 */
  async enable(): Promise<boolean> {
    if (!this.supported) {
      this.opts.onStatus({ active: false, message: '這個瀏覽器不支援媒體鍵' });
      return false;
    }
    if (this.wanted) return true;
    this.wanted = true;

    if (!this.url) this.url = silentLoopUrl(LOOP_SECONDS, SAMPLE_RATE);
    const el = this.el ?? new Audio(this.url);
    el.loop = true;
    el.preload = 'auto';
    // 音量必須非零才拿得到音訊焦點；內容本身聽不見。
    el.volume = 1;
    // 系統或其他 App 搶走焦點時會把它暫停，暫停就等於失去 media session，
    // 按鍵也就停止作用 —— 只要使用者沒關掉就接回去。
    el.onpause = () => {
      if (this.wanted) this.scheduleResume();
    };
    this.el = el;

    const ok = await this.play();
    if (!ok) {
      this.opts.onStatus({ active: false, message: '無法取得媒體控制權，請再試一次' });
      this.disable();
      return false;
    }

    this.bindHandlers();
    this.opts.onStatus({ active: true });
    return true;
  }

  disable(): void {
    this.wanted = false;
    this.clearRetry();
    this.clearHandlers();

    const el = this.el;
    if (el) {
      el.onpause = null;
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.el = null;
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.opts.onStatus({ active: false });
  }

  /**
   * 確認循環還在播。語音播報會短暫搶走音訊焦點，播完要回來確認一下，
   * 否則 media session 掉了、按鍵就沒反應，而畫面上完全看不出來。
   */
  keepAlive(): void {
    if (!this.wanted || !this.el) return;
    if (this.el.paused) this.scheduleResume();
    this.setPlaybackState('playing');
  }

  private bindHandlers(): void {
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, fn: (() => void) | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // 瀏覽器不認得這個動作就跳過，其餘照常註冊。
      }
    };

    set('previoustrack', () => this.opts.onAction('left'));
    set('nexttrack', () => this.opts.onAction('right'));
    // 播放／暫停不拿來計分：按下去若真的把循環停掉，就會連帶失去 media
    // session。這裡一律接回播放，讓按鍵維持有效。
    set('play', () => this.keepAlive());
    set('pause', () => this.keepAlive());

    this.setMetadata();
    this.setPlaybackState('playing');
  }

  private clearHandlers(): void {
    if (!this.supported) return;
    const ms = navigator.mediaSession;
    for (const a of ['previoustrack', 'nexttrack', 'play', 'pause'] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(a, null);
      } catch {
        /* 忽略 */
      }
    }
    this.setPlaybackState('none');
  }

  private setMetadata(): void {
    if (typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '乒乓球記分板',
        artist: '上一曲 = 左方得分 · 下一曲 = 右方得分',
      });
    } catch {
      /* 忽略 */
    }
  }

  private setPlaybackState(state: MediaSessionPlaybackState): void {
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      /* 忽略 */
    }
  }

  private async play(): Promise<boolean> {
    if (!this.el) return false;
    try {
      await this.el.play();
      return true;
    } catch {
      return false;
    }
  }

  private scheduleResume(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      void this.play().then((ok) => {
        if (!ok && this.wanted) this.scheduleResume();
      });
    }, RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

/**
 * 產生一段可循環的 WAV，長度足以讓 Chrome for Android 給出 full audio focus。
 *
 * 振幅刻意壓到 1 LSB（16 bit 下約 -90 dBFS）—— 實際上聽不見，但不是數位
 * 全靜音；全靜音有機會被視為沒有在發聲而拿不到焦點。
 */
export function silentLoopUrl(seconds: number, rate: number): string {
  const frames = Math.round(seconds * rate);
  const dataBytes = frames * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk 長度
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // 單聲道
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  dv.setUint32(40, dataBytes, true);

  // 50Hz、±1 LSB。低頻可避免重取樣時被當成雜訊處理掉。
  const period = Math.max(2, Math.round(rate / 50));
  for (let i = 0; i < frames; i++) {
    dv.setInt16(44 + i * 2, i % period < period / 2 ? 1 : -1, true);
  }

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
