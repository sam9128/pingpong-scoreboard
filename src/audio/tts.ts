/**
 * 語音播報。
 *
 * 實務上的坑（Android 佔了大半）：
 * 1. iOS / Safari 必須先在使用者手勢中呼叫過 speak()，之後才允許發聲 → unlock()。
 *    但同一招在 Android 上反效果：那個沒有聲音的暖身 utterance 有機會不送 onend，
 *    把整個佇列卡死，之後全部靜音，所以 Android 不做這件事。
 * 2. cancel() 之後立刻 speak()，Android 會整段吞掉。中間要隔一拍。
 * 3. speechSynthesis 會卡在 paused，speak() 進去就是不播 → 送出前先 resume()。
 * 4. 指定了裝置上不存在或已失效的 voice 物件同樣是靜默失敗 → 每次都從最新的
 *    getVoices() 重新解析；真的沒開口就退回不指定 voice 再試一次。
 * 5. 播報聲會被麥克風收進去造成自我辨識 → 對外拋出 onSpeakingChange，
 *    由呼叫端在播報期間暫停語音辨識。
 */

/** cancel() 之後要隔多久才送下一段。 */
const CANCEL_SETTLE_MS = 140;
/** 送出後多久還沒開口就視為失敗。 */
const START_TIMEOUT_MS = 1400;

const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** 設定畫面用來說明「為什麼沒有聲音」。 */
export interface VoiceDiagnostics {
  supported: boolean;
  /** 裝置上的語音總數。0 代表語音引擎根本沒回應。 */
  total: number;
  /** 其中的中文語音數。0 代表沒裝中文語音資料，播中文一定沒聲音。 */
  chinese: number;
  /** 目前實際會用到的語音名稱。 */
  resolved: string | null;
  resolvedLang: string | null;
}

export class Announcer {
  enabled = true;
  /** 語速。ITTF 報分講求清楚，範圍刻意收在 0.6 ~ 1.6。 */
  rate = 1.05;
  onSpeakingChange: ((speaking: boolean) => void) | null = null;
  /** 瀏覽器非同步載入語音清單，載完會呼叫這個，讓設定畫面重繪下拉選單。 */
  onVoicesChanged: (() => void) | null = null;
  /** 送出了卻沒發出聲音。設定畫面用它顯示原因，而不是讓使用者對著沉默的板子猜。 */
  onFailure: ((reason: string) => void) | null = null;

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

  diagnose(): VoiceDiagnostics {
    const all = this.supported ? window.speechSynthesis.getVoices() : [];
    return {
      supported: this.supported,
      total: all.length,
      chinese: all.filter((v) => v.lang.toLowerCase().startsWith('zh')).length,
      resolved: this.voice?.name ?? null,
      resolvedLang: this.voice?.lang ?? null,
    };
  }

  /** 傳 null 代表回到自動挑選。 */
  setVoice(uri: string | null): void {
    this.preferredURI = uri && uri.length > 0 ? uri : null;
    this.resolveVoice();
  }

  get voiceURI(): string | null {
    return this.preferredURI;
  }

  /** 目前實際會用到的語音，供設定畫面顯示「自動選擇（…）」。 */
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

    const synth = window.speechSynthesis;
    try {
      if (synth.paused) synth.resume();
    } catch {
      /* 忽略 */
    }
    // Android 不需要手勢解鎖，而空 utterance 反而可能卡住佇列，直接跳過。
    if (isAndroid) return;

    const u = new SpeechSynthesisUtterance('。');
    u.volume = 0;
    // 萬一這一發不送 onend，佇列就永遠卡著，補一道保險把它清掉。
    const guard = window.setTimeout(() => {
      if (!synth.speaking) return;
      try {
        synth.cancel();
      } catch {
        /* 忽略 */
      }
    }, 1500);
    u.onend = () => window.clearTimeout(guard);
    u.onerror = () => window.clearTimeout(guard);
    try {
      synth.speak(u);
    } catch {
      window.clearTimeout(guard);
    }
  }

  say(text: string, opts: { interrupt?: boolean } = {}): void {
    if (!this.supported || !this.enabled || !text.trim()) return;

    // 「即將發聲」必須在 speak() 之前就宣告出去。
    //
    // Android 上正在收音的 SpeechRecognition 會佔住音訊焦點，speak() 根本不會
    // 開始播；若等 onstart 才通知呼叫端停止收音，就會鎖死 —— 收音不停 → 不發聲
    // → onstart 不觸發 → 收音不停，結果就是語音播報整個失效。
    const id = ++this.seq;
    this.active.add(id);
    this.sync();

    if (opts.interrupt) {
      // 只清掉舊的播報，這一段自己的 id 要留著。
      for (const old of this.active) if (old !== id) this.active.delete(old);
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* 忽略 */
      }
      // cancel() 之後立刻 speak()，Android 會整段吞掉，隔一拍再送。
      window.setTimeout(() => this.dispatch(id, text, false), CANCEL_SETTLE_MS);
      return;
    }
    this.dispatch(id, text, false);
  }

  /**
   * 實際送出一段播報。
   *
   * bare = true 代表這是「不指定 voice」的重試：Android 上指定了裝置沒有的語音
   * 會靜默失敗，退掉 voice 通常就能出聲。
   */
  private dispatch(id: number, text: string, bare: boolean): void {
    if (!this.active.has(id)) return; // 已經被後來的 interrupt 取消

    const synth = window.speechSynthesis;
    // Chrome 會卡在 paused，這時候 speak() 進去就是不播。
    try {
      if (synth.paused) synth.resume();
    } catch {
      /* 忽略 */
    }

    const voice = bare ? null : this.freshVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = this.fallbackLang();
    }
    u.rate = this.rate;

    let started = false;
    const finish = (): void => {
      window.clearTimeout(startGuard);
      window.clearTimeout(endGuard);
      if (this.active.delete(id)) this.sync();
    };

    u.onstart = () => {
      started = true;
      window.clearTimeout(startGuard);
    };
    u.onend = finish;
    u.onerror = finish;

    // 送出了卻沒開口 —— Android 最常見的靜默失敗。先退掉 voice 重試一次，
    // 再不行就把原因交給 UI，不要讓使用者對著沉默的板子猜。
    const startGuard = window.setTimeout(() => {
      if (started || synth.speaking) return;
      try {
        synth.cancel();
      } catch {
        /* 忽略 */
      }
      if (!bare) {
        this.dispatch(id, text, true);
        return;
      }
      finish();
      this.reportSilence();
    }, START_TIMEOUT_MS);

    // onend / onerror 都不送時的保險，否則收音永遠不會恢復。
    const endGuard = window.setTimeout(finish, estimateSpeechMs(text, this.rate));

    try {
      synth.speak(u);
    } catch {
      finish();
    }
  }

  /** 每次都重新解析：舊的 voice 物件在 Android 上可能已經失效。 */
  private freshVoice(): SpeechSynthesisVoice | null {
    this.resolveVoice();
    return this.voice;
  }

  /** 沒有可用 voice 物件時的語言碼，盡量貼近裝置真的裝了的中文。 */
  private fallbackLang(): string {
    const zh = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('zh'));
    return zh?.lang ?? 'zh-TW';
  }

  private reportSilence(): void {
    const d = this.diagnose();
    if (d.total === 0) this.onFailure?.('這台裝置的語音引擎沒有回應');
    else if (d.chinese === 0) this.onFailure?.('這台裝置沒有安裝中文語音');
    else this.onFailure?.('語音引擎沒有出聲');
  }

  cancel(): void {
    if (!this.supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 忽略 */
    }
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

/**
 * 播報時長的粗估，只用來當 watchdog 的上限 —— 寧可估長也不要提早放行收音，
 * 否則麥克風會把還沒播完的播報聽成指令。
 */
function estimateSpeechMs(text: string, rate: number): number {
  const perChar = 220 / Math.max(0.5, rate);
  return Math.min(20000, 2500 + text.length * perChar);
}
