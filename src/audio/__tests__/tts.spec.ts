import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 這組測試守的是兩類很容易走回頭路的坑。
 *
 * 一是播報與收音的交握：Android 上正在收音的 SpeechRecognition 會佔住音訊焦點，
 * speak() 不會開始播。若「開始發聲」的通知掛在 utterance.onstart 上，就會鎖死成
 * 收音不停 → 不發聲 → onstart 不觸發 → 收音不停，語音播報整個失效。
 *
 * 二是 Android 的靜默失敗：cancel() 之後立刻 speak() 會被吞掉、指定裝置上沒有的
 * voice 也會被吞掉，兩者都不會拋錯、不會有任何事件。
 */

interface FakeUtterance {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  voice: unknown;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

const log: string[] = [];
let spoken: FakeUtterance[] = [];
let voices: { name: string; lang: string; voiceURI: string }[] = [];

class FakeUtteranceCtor implements FakeUtterance {
  lang = '';
  rate = 1;
  volume = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function synth() {
  return (globalThis as unknown as { speechSynthesis: Record<string, unknown> }).speechSynthesis;
}

beforeEach(() => {
  log.length = 0;
  spoken = [];
  voices = [{ name: '小美', lang: 'zh-TW', voiceURI: 'zh-tw-1' }];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.SpeechSynthesisUtterance = FakeUtteranceCtor;
  g.speechSynthesis = {
    paused: false,
    speaking: false,
    getVoices: () => voices,
    addEventListener: () => {},
    speak: (u: FakeUtterance) => {
      log.push('speak');
      spoken.push(u);
    },
    cancel: () => {
      log.push('cancel');
    },
    resume: () => {
      log.push('resume');
      synth().paused = false;
    },
  };
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.SpeechSynthesisUtterance;
  delete g.speechSynthesis;
});

async function freshAnnouncer() {
  const { Announcer } = await import('../tts');
  const a = new Announcer();
  a.onSpeakingChange = (speaking) => log.push(speaking ? 'pause-mic' : 'resume-mic');
  return a;
}

describe('Announcer 與收音的交握', () => {
  it('先通知暫停收音，才呼叫 speak()', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    expect(log).toEqual(['pause-mic', 'speak']);
  });

  it('播完才通知恢復收音', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    spoken[0]?.onend?.();
    expect(log).toEqual(['pause-mic', 'speak', 'resume-mic']);
  });

  it('speak() 擲例外時仍會恢復收音，不會把麥克風鎖死', async () => {
    const a = await freshAnnouncer();
    synth().speak = () => {
      throw new Error('boom');
    };
    a.say('三比二');
    expect(log).toEqual(['pause-mic', 'resume-mic']);
  });

  it('連續播報之間不會來回開關收音', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    a.say('王小明發球');
    expect(log).toEqual(['pause-mic', 'speak', 'speak']);
    spoken[0]?.onend?.();
    expect(log.filter((x) => x === 'resume-mic')).toHaveLength(0);
    spoken[1]?.onend?.();
    expect(log.at(-1)).toBe('resume-mic');
  });

  it('cancel() 之後遲到的 onend 不會誤放行下一段播報的收音', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    a.cancel();
    expect(log.at(-1)).toBe('resume-mic');

    a.say('四比二');
    expect(log.at(-1)).toBe('speak');
    spoken[0]?.onend?.();
    expect(log.at(-1)).toBe('speak');
    spoken[1]?.onend?.();
    expect(log.at(-1)).toBe('resume-mic');
  });

  it('關閉播報時不會動到收音', async () => {
    const a = await freshAnnouncer();
    a.enabled = false;
    a.say('三比二');
    expect(log).toEqual([]);
  });
});

describe('Android 的靜默失敗', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('interrupt 先 cancel，隔一拍才 speak', async () => {
    const a = await freshAnnouncer();
    a.say('三比二', { interrupt: true });
    // 立刻送 speak() 的話 Android 會整段吞掉，所以這時候還不能有 speak
    expect(log).toEqual(['pause-mic', 'cancel']);
    vi.advanceTimersByTime(200);
    expect(log).toEqual(['pause-mic', 'cancel', 'speak']);
  });

  it('speechSynthesis 卡在 paused 時先 resume 再送', async () => {
    const a = await freshAnnouncer();
    synth().paused = true;
    a.say('三比二');
    expect(log).toEqual(['pause-mic', 'resume', 'speak']);
  });

  it('送出後沒開口，退掉 voice 再試一次', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    expect(spoken[0]?.voice).not.toBeNull();

    // 沒有 onstart、synth.speaking 仍為 false —— 典型的 Android 靜默失敗
    vi.advanceTimersByTime(1500);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.voice).toBeNull();
    expect(spoken[1]?.lang).toBe('zh-TW');
    // 重試期間不可以放行收音，否則麥克風會收到接下來的播報
    expect(log.filter((x) => x === 'resume-mic')).toHaveLength(0);
  });

  it('重試仍然沒開口就回報原因，並恢復收音', async () => {
    const a = await freshAnnouncer();
    const reasons: string[] = [];
    a.onFailure = (r) => reasons.push(r);

    a.say('三比二');
    vi.advanceTimersByTime(1500);
    vi.advanceTimersByTime(1500);
    expect(reasons).toEqual(['語音引擎沒有出聲']);
    expect(log.at(-1)).toBe('resume-mic');
  });

  it('裝置沒有中文語音時講清楚是哪一種失敗', async () => {
    voices = [{ name: 'Alex', lang: 'en-US', voiceURI: 'en-1' }];
    const a = await freshAnnouncer();
    const reasons: string[] = [];
    a.onFailure = (r) => reasons.push(r);

    a.say('三比二');
    vi.advanceTimersByTime(1500);
    vi.advanceTimersByTime(1500);
    expect(reasons).toEqual(['這台裝置沒有安裝中文語音']);
  });

  it('開口之後就不再重試', async () => {
    const a = await freshAnnouncer();
    a.say('三比二');
    spoken[0]?.onstart?.();
    vi.advanceTimersByTime(1500);
    expect(spoken).toHaveLength(1);
  });

  it('diagnose 回報語音引擎的實際狀態', async () => {
    voices = [
      { name: '小美', lang: 'zh-TW', voiceURI: 'zh-tw-1' },
      { name: 'Alex', lang: 'en-US', voiceURI: 'en-1' },
    ];
    const a = await freshAnnouncer();
    expect(a.diagnose()).toEqual({
      supported: true,
      total: 2,
      chinese: 1,
      resolved: '小美',
      resolvedLang: 'zh-TW',
    });
  });
});
