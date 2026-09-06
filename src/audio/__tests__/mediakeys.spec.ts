import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaKeyScorer, silentLoopUrl } from '../mediakeys';

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

function makeScorer(onAction: (a: 'left' | 'right') => void = () => undefined) {
  return new MediaKeyScorer({ onAction, onStatus: () => undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers = {};
  audios = [];
  blobs = [];
  playShouldFail = false;

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
  it('上一曲 = 左方得分、下一曲 = 右方得分', async () => {
    const got: string[] = [];
    const scorer = makeScorer((a) => got.push(a));
    await scorer.enable();

    handlers['previoustrack']?.();
    handlers['nexttrack']?.();
    expect(got).toEqual(['left', 'right']);
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

  it('播放／暫停鍵不計分，只把循環接回來', async () => {
    const got: string[] = [];
    const scorer = makeScorer((a) => got.push(a));
    await scorer.enable();
    const el = audios.at(-1);

    el?.pause();
    handlers['pause']?.();
    handlers['play']?.();
    expect(got).toEqual([]);

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

  it('disable() 之後解除所有 handler，也不再自動接回', async () => {
    const scorer = makeScorer();
    await scorer.enable();
    const el = audios.at(-1);

    scorer.disable();
    expect(scorer.active).toBe(false);
    for (const a of ['previoustrack', 'nexttrack', 'play', 'pause']) {
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
