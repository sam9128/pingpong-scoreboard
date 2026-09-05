import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 這組測試守的是一個很容易走回頭路的坑：
 * Android 上正在收音的 SpeechRecognition 會佔住音訊焦點，speak() 不會開始播。
 * 若「開始發聲」的通知掛在 utterance.onstart 上，就會鎖死成
 * 收音不停 → 不發聲 → onstart 不觸發 → 收音不停，語音播報整個失效。
 */

interface FakeUtterance {
  text: string;
  lang: string;
  rate: number;
  volume: number;
  voice: unknown;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

const log: string[] = [];
let spoken: FakeUtterance[] = [];

class FakeUtteranceCtor implements FakeUtterance {
  lang = '';
  rate = 1;
  volume = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

beforeEach(() => {
  log.length = 0;
  spoken = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.SpeechSynthesisUtterance = FakeUtteranceCtor;
  g.speechSynthesis = {
    getVoices: () => [],
    addEventListener: () => {},
    speak: (u: FakeUtterance) => {
      log.push('speak');
      spoken.push(u);
    },
    cancel: () => {
      log.push('cancel');
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
    expect(log).toEqual(['pause-mic', 'speak']);
    spoken[0]?.onend?.();
    expect(log).toEqual(['pause-mic', 'speak', 'resume-mic']);
  });

  it('speak() 擲例外時仍會恢復收音，不會把麥克風鎖死', async () => {
    const a = await freshAnnouncer();
    (globalThis as unknown as { speechSynthesis: { speak: () => void } }).speechSynthesis.speak =
      () => {
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
    // 前一段被取消的播報這時才把 onend 送回來
    spoken[0]?.onend?.();
    // 仍在播第二段，不可以恢復收音
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
