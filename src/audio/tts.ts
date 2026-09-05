/**
 * 語音播報。
 *
 * 兩個實務上的坑：
 * 1. iOS / Safari 必須先在使用者手勢中呼叫過 speak()，之後才允許發聲 → unlock()。
 * 2. 播報聲會被麥克風收進去造成自我辨識 → 對外拋出 onSpeakingChange，
 *    由呼叫端在播報期間暫停語音辨識。
 */
export class Announcer {
  enabled = true;
  /** 語速。ITTF 報分講求清楚，範圍刻意收在 0.6 ~ 1.6。 */
  rate = 1.05;
  onSpeakingChange: ((speaking: boolean) => void) | null = null;
  /** 瀏覽器非同步載入語音清單，載完會呼叫這個，讓設定畫面重繪下拉選單。 */
  onVoicesChanged: (() => void) | null = null;

  private voice: SpeechSynthesisVoice | null = null;
  /** 使用者指定的語音；null 代表交給自動挑選。 */
  private preferredURI: string | null = null;
  private unlocked = false;
  /** 尚未結束的播報。用集合而非計數，cancel() 之後遲到的 onend 才不會誤減。 */
  private active = new Set<number>();
  private seq = 0;
  private speaking = false;

  readonly supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  constructor() {
    if (!this.supported) return;
    this.resolveVoice();
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      this.resolveVoice();
      this.onVoicesChanged?.();
    });
  }

  /** 可選的語音清單：中文排前面，其餘依語言碼排序。 */
  listVoices(): SpeechSynthesisVoice[] {
    if (!this.supported) return [];
    const all = window.speechSynthesis.getVoices();
    const isZh = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith('zh');
    return [
      ...all.filter(isZh).sort((a, b) => a.lang.localeCompare(b.lang)),
      ...all.filter((v) => !isZh(v)).sort((a, b) => a.lang.localeCompare(b.lang)),
    ];
  }

  /** 傳 null 代表回到自動挑選。 */
  setVoice(uri: string | null): void {
    this.preferredURI = uri && uri.length > 0 ? uri : null;
    this.resolveVoice();
  }

  get voiceURI(): string | null {
    return this.preferredURI;
  }

  /** 目前實際會用到的語音，供設定畫面顯示「自動選擇（實際使用 …）」。 */
  get resolvedVoiceName(): string | null {
    return this.voice?.name ?? null;
  }

  private resolveVoice(): void {
    if (!this.supported) return;
    const all = window.speechSynthesis.getVoices();
    if (this.preferredURI) {
      const hit = all.find((v) => v.voiceURI === this.preferredURI);
      if (hit) {
        this.voice = hit;
        return;
      }
      // 指定的語音在這台裝置上不存在（例如換了裝置），退回自動挑選。
    }
    this.voice = pickChineseVoice(all);
  }

  /** 必須在使用者手勢（點擊、觸控）中呼叫一次。 */
  unlock(): void {
    if (!this.supported || this.unlocked) return;
    this.unlocked = true;
    const u = new SpeechSynthesisUtterance('​');
    u.volume = 0;
    try {
      window.speechSynthesis.speak(u);
    } catch {
      /* 忽略 */
    }
  }

  say(text: string, opts: { interrupt?: boolean } = {}): void {
    if (!this.supported || !this.enabled || !text.trim()) return;
    if (opts.interrupt) this.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice?.lang ?? 'zh-TW';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;

    // 「即將發聲」必須在 speak() 之前就宣告出去。
    //
    // Android 上正在收音的 SpeechRecognition 會佔住音訊焦點，speak() 根本不會
    // 開始播；若等 onstart 才通知呼叫端停止收音，就會鎖死 —— 收音不停 → 不發聲
    // → onstart 不觸發 → 收音不停，結果就是語音播報整個失效。
    const id = ++this.seq;
    this.active.add(id);
    this.sync();

    const done = (): void => {
      window.clearTimeout(watchdog);
      if (this.active.delete(id)) this.sync();
    };
    u.onend = done;
    u.onerror = done;
    // Chrome 偶爾 onend / onerror 都不送，留一道保險，否則收音永遠不會恢復。
    const watchdog = window.setTimeout(done, estimateSpeechMs(text, this.rate));

    try {
      window.speechSynthesis.speak(u);
    } catch {
      done();
    }
  }

  cancel(): void {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
    this.active.clear();
    this.sync();
  }

  private sync(): void {
    const now = this.active.size > 0;
    if (now === this.speaking) return;
    this.speaking = now;
    this.onSpeakingChange?.(now);
  }
}

/**
 * 播報時長的粗估，只用來當 watchdog 的上限 —— 寧可估長也不要提早放行收音，
 * 否則麥克風會把還沒播完的播報聽成指令。
 */
function estimateSpeechMs(text: string, rate: number): number {
  const perChar = 220 / Math.max(0.5, rate);
  return Math.min(20000, 2500 + text.length * perChar);
}

/** 優先台灣中文，其次其他中文，最後放棄讓瀏覽器自行決定。 */
function pickChineseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const order = ['zh-tw', 'zh-hant', 'zh-hk', 'zh-cn', 'zh'];
  for (const prefix of order) {
    const hit = voices.find((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix));
    if (hit) return hit;
  }
  return null;
}
