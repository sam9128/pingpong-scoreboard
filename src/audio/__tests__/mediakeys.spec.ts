import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEDIA_MAP, MediaKeyScorer, silentLoopUrl } from '../mediakeys';
import type { MediaKeyMap, MediaKeyRole } from '../mediakeys';

/**
 * 這組測試守兩件事：
 *
 * 1. 那段循環音訊的格式必須真的是合法 WAV，而且長度 >= 5 秒 ——
 *    Chrome for Android 只有在媒體長度 >= 5 秒時才會給 full audio focus，
 *    拿不到焦點就收不到耳機按鍵，而且畫面上完全看不出來。
 * 2. 循環被暫停就等於失去 media session。暫停必須自動接回去。
 */

interface FakeAudio {
  loop: boolean;
  volume: number;
  preload: string;
  paused: boolean;
  onpause: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(n: string): void;
  load(): void;
}

let handlers: Record<string, (() => void) | null> = {};
let binds = 0;
let audios: FakeAudio[] = [];
let playShouldFail = false;
let blobs: { type: string; size: number }[] = [];

class FakeAudioCtor implements FakeAudio {
  loop = false;
  volume = 0;
  preload = '';
  paused = true;
  onpause: (() => void) | null = null;
  constructor(public src: string) {
    audios.push(this);
  }
  async play(): Promise<void> {
    if (playShouldFail) throw new Error('blocked');
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(): void {}
  load(): void {}
}

let map: MediaKeyMap = { ...DEFAULT_MEDIA_MAP };

function makeScorer(onAction: (r: MediaKeyRole) => void = () => undefined) {
  return new MediaKeyScorer({ onAction, onStatus: () => undefined, getMap: () => map });
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers = {};
  binds = 0;
  audios = [];
  blobs = [];
  playShouldFail = false;
  map = { ...DEFAULT_MEDIA_MAP };

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.Audio = FakeAudioCtor;
  // Node 的 navigator 是唯讀存取子，只能用 defineProperty 蓋掉。
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent: 'test',
      mediaSession: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: (a: string, fn: (() => void) | null) => {
          binds++;
          handlers[a] = fn;
        },
      },
    },
  });
  g.URL = {
    createObjectURL: (b: Blob) => {
      blobs.push({ type: b.type, size: b.size });
      return 'blob:fake';
    },
    revokeObjectURL: () => undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['window', 'Audio', 'URL']) delete g[k];
  Reflect.deleteProperty(globalThis, 'navigator');
});

describe('循環音訊', () => {
  it('是合法的 WAV，取樣率與長度都寫對', () => {
    silentLoopUrl(8, 8000);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('audio/wav');
    // 44 bytes 檔頭 + 8 秒 * 8000Hz * 2 bytes（16 bit 單聲道）
    expect(blobs[0]?.size).toBe(44 + 8 * 8000 * 2);
  });

  it('長度必須 >= 5 秒，否則 Chrome for Android 不給 full audio focus', () => {
    const scorer = makeScorer();
    void scorer.enable();
    const bytes = blobs[0]?.size ?? 0;
    const seconds = (bytes - 44) / (8000 * 2);
    expect(seconds).toBeGreaterThanOrEqual(5);
  });
});

describe('MediaKeyScorer', () => {
  it('預設對應：上一曲 = 左、下一曲 = 右、播放暫停 = 返回', async () => {
    const got: string[] = [];
    const scorer = makeScorer((r) => got.push(r));
    await scorer.enable();

    handlers['previoustrack']?.();
    handlers['nexttrack']?.();
    handlers['pause']?.();
    expect(got).toEqual(['left', 'right', 'undo']);
  });

  it('照著對應表走 —— 換成快轉／倒轉也一樣', async () => {
    map = { left: 'seekbackward', right: 'seekforward', undo: 'none' };
    const got: string[] = [];
    const scorer = makeScorer((r) => got.push(r));
    await scorer.enable();

    handlers['seekbackward']?.();
    handlers['seekforward']?.();
    expect(got).toEqual(['left', 'right']);
    // 沒有指派的按鍵不可以殘留舊的處理函式
    expect(handlers['previoustrack']).toBeNull();
    expect(handlers['nexttrack']).toBeNull();
  });

  it('沒有角色用 playpause 時，它仍然要接管，否則會失去 media session', async () => {
    map = { left: 'previoustrack', right: 'nexttrack', undo: 'none' };
    const got: string[] = [];
    const scorer = makeScorer((r) => got.push(r));
    await scorer.enable();
    const el = audios.at(-1);

    el?.pause();
    handlers['pause']?.();
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(el?.paused).toBe(false);
  });

  it('refresh() 會套用改過的對應表', async () => {
    const got: string[] = [];
    const scorer = makeScorer((r) => got.push(r));
    await scorer.enable();

    map = { ...map, left: 'nexttrack', right: 'none' };
    scorer.refresh();
    handlers['nexttrack']?.();
    expect(got).toEqual(['left']);
  });

  it('接管後循環是播放中的，而且音量非零', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);
    expect(el?.paused).toBe(false);
    expect(el?.loop).toBe(true);
    // 音量為 0 拿不到音訊焦點
    expect(el?.volume).toBeGreaterThan(0);
  });

  it('循環被暫停會自動接回去 —— 停掉就等於失去 media session', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);

    el?.pause();
    el?.onpause?.();
    expect(el?.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(el?.paused).toBe(false);
  });

  it('keepAlive 在播報之後把被搶走的循環接回來', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);

    el?.pause(); // 模擬播報搶走音訊焦點
    scorer.keepAlive();
    await vi.advanceTimersByTimeAsync(1000);
    expect(el?.paused).toBe(false);
  });

  it('同一次按鍵送來 pause 再送 play 只算一分', async () => {
    const got: string[] = [];
    const scorer = makeScorer((r) => got.push(r));
    await scorer.enable();

    // 我們被暫停後會立刻接回去，狀態一翻系統可能補送另一發。
    handlers['pause']?.();
    handlers['play']?.();
    expect(got).toEqual(['undo']);

    // 隔得夠久就是真的按了第二下。
    await vi.advanceTimersByTimeAsync(400);
    handlers['pause']?.();
    expect(got).toEqual(['undo', 'undo']);
  });

  it('循環還在播時，播報結束不可以去擾動 media session', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);
    expect(el?.paused).toBe(false);

    // 停一下再播、或重註冊 handler，都會讓下一下按鍵被系統吃掉。
    let paused = false;
    const realPause = el!.pause.bind(el);
    el!.pause = () => {
      paused = true;
      realPause();
    };
    const before = binds;

    scorer.keepAlive();
    await vi.advanceTimersByTimeAsync(1000);
    expect(paused).toBe(false);
    expect(el?.paused).toBe(false);
    expect(binds).toBe(before);
    expect(navigator.mediaSession.playbackState).toBe('playing');
  });

  it('循環在無人察覺時停掉，看門狗會把它接回來', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);

    // 沒有 onpause 事件的失去焦點（例如被系統直接靜掉）
    if (el) el.paused = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(el?.paused).toBe(false);
  });

  it('每個收到的動作都會回報，方便在手機上確認按鍵有沒有送到', async () => {
    const seen: string[] = [];
    const scorer = new MediaKeyScorer({
      onAction: () => undefined,
      onStatus: () => undefined,
      getMap: () => map,
      onKey: (a, r) => seen.push(`${a}:${r}`),
    });
    await scorer.enable();

    handlers['nexttrack']?.();
    handlers['pause']?.();
    // 被當成同一次按鍵的第二發也要看得到，否則使用者只會覺得少算一分
    handlers['play']?.();
    expect(seen).toEqual(['nexttrack:ok', 'pause:ok', 'play:dup']);
  });

  it('沒有指派角色的播放暫停會回報「未指派」', async () => {
    map = { left: 'previoustrack', right: 'nexttrack', undo: 'none' };
    const seen: string[] = [];
    const scorer = new MediaKeyScorer({
      onAction: () => undefined,
      onStatus: () => undefined,
      getMap: () => map,
      onKey: (a, r) => seen.push(`${a}:${r}`),
    });
    await scorer.enable();

    handlers['pause']?.();
    expect(seen).toEqual(['pause:unset']);
  });

  it('disable() 之後解除所有 handler，也不再自動接回', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);

    scorer.disable();
    expect(scorer.active).toBe(false);
    for (const a of ['previoustrack', 'nexttrack', 'play', 'pause', 'seekbackward', 'seekforward']) {
      expect(handlers[a]).toBeNull();
    }

    el?.pause();
    await vi.advanceTimersByTimeAsync(2000);
    expect(el?.paused).toBe(true);
  });

  it('play() 被自動播放政策擋下時不會留下半開狀態', async () => {
    playShouldFail = true;
    const scorer = makeScorer();
    const ok = await scorer.enable();
    expect(ok).toBe(false);
    expect(scorer.active).toBe(false);
  });
});
