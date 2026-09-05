import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOCAB, VoiceScorer } from '../stt';

/**
 * 這組測試分開兩件很容易被混為一談的事：
 *
 * - active   使用者的意向 —— 語音計分開著沒。播報期間不會變。
 * - listening 此刻是不是真的在收音。播報期間為 false。
 *
 * 指示燈要看 active，看 listening 的話每報一次分就熄一次；
 * 而偏好只能在「使用者自己按開關」與「權限被拒絕」時寫回 ——
 * 結束對局呼叫的 stop() 是收拾場面，不是使用者關掉它。
 */

class FakeRec {
  static instances: FakeRec[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: unknown = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;

  constructor() {
    FakeRec.instances.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {}
  abort(): void {
    this.aborted = true;
  }
}

interface Status {
  active: boolean;
  listening: boolean;
  message?: string;
}

let statuses: Status[] = [];
let denied = 0;

function makeScorer() {
  return new VoiceScorer({
    getNames: () => ['王小明', '李大華'],
    getVocab: () => DEFAULT_VOCAB,
    onCommand: () => undefined,
    onStatus: (s) => statuses.push(s),
    onDenied: () => denied++,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  statuses = [];
  denied = 0;
  FakeRec.instances = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.webkitSpeechRecognition = FakeRec;
});

afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.webkitSpeechRecognition;
});

describe('VoiceScorer 的意向與收音狀態', () => {
  it('start() 之後兩者都為真', () => {
    const v = makeScorer();
    v.start();
    expect(v.active).toBe(true);
    expect(v.listening).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ active: true, listening: true });
  });

  it('播報期間 active 不變，只有 listening 轉為 false', () => {
    const v = makeScorer();
    v.start();
    v.pause();
    expect(v.active).toBe(true);
    expect(v.listening).toBe(false);
    // 指示燈看的是 active，所以播報時不會熄
    expect(statuses.at(-1)).toMatchObject({ active: true, listening: false });

    v.resume();
    vi.advanceTimersByTime(400);
    expect(v.listening).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ active: true, listening: true });
  });

  it('播報期間麥克風不關掉 —— 關掉再開就是提示音的來源', () => {
    const v = makeScorer();
    v.start();
    const rec = FakeRec.instances.at(-1);
    expect(FakeRec.instances).toHaveLength(1);

    v.pause();
    expect(rec?.aborted).toBe(false);
    v.resume();
    vi.advanceTimersByTime(400);
    // 整段播報期間都用同一個 session，沒有重新 start()
    expect(FakeRec.instances).toHaveLength(1);
  });

  it('播報期間聽到的話一律不採信', () => {
    const heard: string[] = [];
    const v = new VoiceScorer({
      getNames: () => ['王小明', '李大華'],
      getVocab: () => DEFAULT_VOCAB,
      onCommand: (_cmd, t) => heard.push(t),
      onStatus: (s) => statuses.push(s),
      onDenied: () => denied++,
    });
    v.start();
    const rec = FakeRec.instances.at(-1) as unknown as {
      onresult: (e: unknown) => void;
    };
    const say = (text: string) =>
      rec.onresult({
        resultIndex: 0,
        results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: text } } },
      });

    v.pause();
    say('左邊得分');
    expect(heard).toEqual([]);

    v.resume();
    vi.advanceTimersByTime(400);
    say('左邊得分');
    expect(heard).toEqual(['左邊得分']);
  });

  it('尾音期間仍然不採信，避免把自己的播報聽成指令', () => {
    const v = makeScorer();
    v.start();
    v.pause();
    v.resume();
    // 尾音還沒過完
    vi.advanceTimersByTime(100);
    expect(v.listening).toBe(false);
    vi.advanceTimersByTime(400);
    expect(v.listening).toBe(true);
  });

  it('先被播報 pause、後才 start，仍然算是開著', () => {
    // 開賽時就是這個順序：先播「比賽開始…」，才啟動收音
    const v = makeScorer();
    v.pause();
    v.start();
    expect(v.active).toBe(true);
    expect(v.listening).toBe(false);

    v.resume();
    vi.advanceTimersByTime(400);
    expect(v.listening).toBe(true);
    expect(FakeRec.instances.some((r) => r.started)).toBe(true);
  });

  it('stop() 關掉意向，但不算是使用者拒絕，不動偏好', () => {
    const v = makeScorer();
    v.start();
    v.stop();
    expect(v.active).toBe(false);
    expect(denied).toBe(0);
  });

  it('麥克風權限被拒絕才會回報 onDenied', () => {
    const v = makeScorer();
    v.start();
    FakeRec.instances.at(-1)?.onerror?.({ error: 'not-allowed' });
    expect(denied).toBe(1);
    expect(v.active).toBe(false);
    expect(statuses.at(-1)?.message).toBe('麥克風權限被拒絕');
  });

  it('網路錯誤不算使用者拒絕，意向保持不變', () => {
    const v = makeScorer();
    v.start();
    FakeRec.instances.at(-1)?.onerror?.({ error: 'network' });
    expect(denied).toBe(0);
    expect(v.active).toBe(true);
    expect(statuses.at(-1)?.message).toBe('語音辨識需要網路連線');
  });
});
