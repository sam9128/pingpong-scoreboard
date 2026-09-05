/**
 * 語音計分（Web Speech API）。
 *
 * 已知限制，請在 UI 上誠實呈現：
 * - Chrome / Edge / Safari 支援，Firefox 不支援。
 * - 多數實作是把音訊送到雲端辨識，因此需要網路 —— 離線安裝後這項功能會失效。
 * - 球館環境噪音大，因此採「白名單指令 + 得分後可撤銷」的保守策略，
 *   語音永遠只是輔助，主操作仍是點擊畫面。
 */
import type { PlayerIndex } from '../rules/types';

export type Side = 'left' | 'right';

export type VoiceCommand =
  | { kind: 'point'; side: Side }
  | { kind: 'pointByPlayer'; player: PlayerIndex }
  | { kind: 'timeout'; side: Side }
  | { kind: 'undo' };

/** 可由使用者自訂的指令詞彙。 */
export interface Vocabulary {
  left: string[];
  right: string[];
  undo: string[];
  timeout: string[];
  /** 明確表示「這是一次計分」的詞，說了就不受短句長度限制。 */
  point: string[];
}

export const DEFAULT_VOCAB: Vocabulary = {
  left: ['左邊', '左方', '左側', '左手邊', '左'],
  right: ['右邊', '右方', '右側', '右手邊', '右'],
  undo: ['取消', '撤銷', '撤消', '復原', '還原', '不算', '重來', '收回'],
  timeout: ['暫停', '喊停'],
  point: ['得分', '加分', '一分', '得點', '拿分', '進分'],
};

/** 把使用者輸入的「甲、乙, 丙」拆成詞彙陣列。 */
export function parsePhrases(input: string): string[] {
  return input
    .split(/[,，、;；|\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export function formatPhrases(list: readonly string[]): string {
  return list.join('、');
}

/** 未明確說出「得分」時，可接受的最長句子長度（正規化後的字數）。 */
const MAX_IMPLICIT_LEN = 6;

/** 去掉空白與標點，統一小寫，讓辨識結果的細節差異不影響比對。 */
export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s,.!?;:、，。！？；：「」『』()（）]/g, '');
}

const hasAny = (text: string, words: readonly string[]): boolean =>
  words.some((w) => text.includes(w));

/**
 * 把辨識到的句子比對成指令。比對不到就回傳 null —— 寧可漏判也不要誤判。
 */
export function matchCommand(
  raw: string,
  names: readonly [string, string],
  vocab: Vocabulary = DEFAULT_VOCAB,
): VoiceCommand | null {
  const text = normalize(raw);
  if (!text) return null;

  // 撤銷最優先：誤判一次得分的代價，遠高於漏聽一次撤銷。
  if (hasAny(text, vocab.undo)) return { kind: 'undo' };

  const side: Side | null = hasAny(text, vocab.left)
    ? 'left'
    : hasAny(text, vocab.right)
      ? 'right'
      : null;

  if (hasAny(text, vocab.timeout)) {
    return side ? { kind: 'timeout', side } : null;
  }

  // 明確說了「得分」就一律採信；否則只接受短句，
  // 避免場邊閒聊中出現的「左」「右」被當成計分指令。
  const explicit = hasAny(text, vocab.point);
  if (!explicit && text.length > MAX_IMPLICIT_LEN) return null;

  // 選手姓名優先於左右，因為換邊後左右會改變、姓名不會。
  const named = matchName(text, names);
  if (named !== null) return { kind: 'pointByPlayer', player: named };

  if (side) return { kind: 'point', side };

  // 只喊「得分」卻沒指明是誰，無從判斷，寧可不動作。
  return null;
}

/** 兩位選手都命中（例如名字互為子字串）時視為無法判斷。 */
function matchName(text: string, names: readonly [string, string]): PlayerIndex | null {
  const a = normalize(names[0]);
  const b = normalize(names[1]);
  const hitA = a.length > 0 && text.includes(a);
  const hitB = b.length > 0 && text.includes(b);
  if (hitA && !hitB) return 0;
  if (hitB && !hitA) return 1;
  return null;
}

// ── 瀏覽器 API 的最小型別宣告（lib.dom 尚未涵蓋） ──────────────

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceScorerOptions {
  getNames: () => [string, string];
  getVocab: () => Vocabulary;
  onCommand: (cmd: VoiceCommand, transcript: string) => void;
  /**
   * active = 使用者的意向（開著沒），listening = 此刻真的在收音。
   * 播報期間 listening 會短暫轉 false，active 不變 —— 指示燈要看 active，
   * 否則每報一次分就熄一次。
   */
  onStatus: (status: { active: boolean; listening: boolean; message?: string }) => void;
}

/** 連續辨識期間，兩個指令之間的最短間隔，避免同一句話被重複判成兩分。 */
const COOLDOWN_MS = 900;
/** 辨識服務自行結束後多快接回去。夠短才不會在語句之間漏聽。 */
const RESTART_MS = 250;
/** 播報結束後再忽略一小段，把還在空氣裡的尾音吃掉。 */
const MUTE_TAIL_MS = 350;
/**
 * 空轉時的重啟間隔。
 *
 * 辨識服務靜音幾秒就自行結束，而每次 start() 系統都會播一次提示音 ——
 * 這是唯一還消不掉的一聲。沒人講話時逐步拉長間隔讓它安靜下來，一聽到
 * 有人說話就回到最短的那一段。實際打球時每一分前後都有人出聲，因此
 * 間隔會維持在短的那一端，效果接近一分一次。
 */
const RESTART_STEPS = [400, 900, 1800, 3500, 6000] as const;

export class VoiceScorer {
  readonly supported: boolean;

  private ctor = getCtor();
  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  /**
   * 播報期間「不採信」而不是「關掉」麥克風。
   *
   * 關掉再開，Android 每次 start() 都會播一次系統提示音 —— 一分一次，
   * 這是提示音最主要的來源。收音一路開著、只把播報期間的辨識結果丟掉，
   * 一樣不會把自己的播報聽成指令，卻少掉每一分的那一聲。
   */
  private muted = false;
  private unmuteTimer: number | null = null;
  private lastAcceptedAt = 0;
  private restartTimer: number | null = null;
  /** 連續幾個 session 從頭到尾沒聽到任何話。用來決定重啟間隔。 */
  private idleStreak = 0;
  /** 這一個 session 有沒有聽到過完整句子。 */
  private heardThisSession = false;

  constructor(private opts: VoiceScorerOptions) {
    this.supported = this.ctor !== null;
  }

  /** 使用者的意向：語音計分是不是開著。播報期間不會變。 */
  get active(): boolean {
    return this.wanted;
  }

  /** 此刻是不是在採信聽到的話。播報期間為 false（但麥克風沒有關）。 */
  get listening(): boolean {
    return this.wanted && !this.muted;
  }

  private notify(message?: string): void {
    this.opts.onStatus({ active: this.wanted, listening: this.listening, message });
  }

  toggle(): void {
    if (this.wanted) this.stop();
    else this.start();
  }

  start(): void {
    if (!this.supported) {
      this.notify('這個瀏覽器不支援語音辨識');
      return;
    }
    this.wanted = true;
    this.idleStreak = 0;
    this.spinUp();
    this.notify();
  }

  stop(): void {
    this.wanted = false;
    this.clearUnmute();
    this.muted = false;
    this.clearRestart();
    this.tearDown();
    this.notify();
  }

  /** 播報期間不採信聽到的話。麥克風保持開著，避免每一分都響一次提示音。 */
  pause(): void {
    this.clearUnmute();
    if (this.muted) return;
    this.muted = true;
    this.notify();
  }

  resume(): void {
    if (!this.muted || this.unmuteTimer !== null) return;
    // 播報的尾音還在空氣裡，再忽略一小段才開始採信。
    this.unmuteTimer = window.setTimeout(() => {
      this.unmuteTimer = null;
      this.muted = false;
      // 剛播報完代表剛得了一分，場邊正熱鬧，回到最靈敏的節奏。
      this.idleStreak = 0;
      // 這段期間辨識服務若自行結束過，這裡把它接回來。
      if (this.wanted && !this.rec) this.scheduleRestart(RESTART_MS);
      this.notify();
    }, MUTE_TAIL_MS);
  }

  private clearUnmute(): void {
    if (this.unmuteTimer !== null) {
      clearTimeout(this.unmuteTimer);
      this.unmuteTimer = null;
    }
  }

  private spinUp(): void {
    // 刻意不看 muted：播報期間也讓收音一路開著，才不會一分響一次提示音。
    if (!this.ctor || this.rec || !this.wanted) return;
    this.heardThisSession = false;
    const rec = new this.ctor();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 3;

    rec.onresult = (e) => this.handleResult(e);

    rec.onerror = (e) => {
      const err = e.error ?? '';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // 這一場拿不到權限就不收音，但意向不寫回偏好 —— 「把提示框滑掉」
        // 與「按封鎖」都是 not-allowed，前者不該讓設定永久消失。
        this.wanted = false;
        this.notify('麥克風權限被拒絕');
      } else if (err === 'network') {
        this.notify('語音辨識需要網路連線');
      }
    };

    rec.onend = () => {
      this.rec = null;
      // continuous 在行動裝置上形同虛設：辨識服務靜音幾秒就會自行結束。
      // 整段都沒聽到話就把下次的間隔拉長，否則維持最短。
      // 先用目前的空轉次數決定這一次要等多久，再把次數往上加 ——
      // 第一次空轉仍然是最短的 400ms，之後才逐步拉長。
      const delay = this.restartDelay();
      if (!this.heardThisSession) this.idleStreak++;
      if (this.wanted) this.scheduleRestart(delay);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      // 前一個 session 尚未完全結束時會擲出 InvalidStateError，稍後重試。
      this.rec = null;
      this.scheduleRestart(500);
    }
  }

  private handleResult(e: SpeechRecognitionEventLike): void {
    // 播報期間照收不誤，只是一律不採信 —— 否則會把自己的播報聽成指令。
    if (this.muted) return;
    if (Date.now() - this.lastAcceptedAt < COOLDOWN_MS) return;
    const names = this.opts.getNames();
    const vocab = this.opts.getVocab();

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (!result?.isFinal) continue;
      // 附近有人在講話：這一個 session 不算空轉，重啟節奏回到最短。
      this.heardThisSession = true;
      this.idleStreak = 0;
      for (let j = 0; j < result.length; j++) {
        const transcript = result[j]?.transcript ?? '';
        const cmd = matchCommand(transcript, names, vocab);
        if (cmd) {
          this.lastAcceptedAt = Date.now();
          this.opts.onCommand(cmd, transcript.trim());
          return;
        }
      }
    }
  }

  /** 空轉越久間隔越長，上限 6 秒；一聽到話就回到最短。 */
  private restartDelay(): number {
    return RESTART_STEPS[Math.min(this.idleStreak, RESTART_STEPS.length - 1)] ?? RESTART_MS;
  }

  private scheduleRestart(delay: number): void {
    this.clearRestart();
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      this.spinUp();
    }, delay);
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private tearDown(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.onend = null;
    rec.onresult = null;
    rec.onerror = null;
    try {
      rec.abort();
    } catch {
      /* 忽略 */
    }
  }
}
