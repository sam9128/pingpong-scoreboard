import { describe, expect, it } from 'vitest';
import type { BestOf, MatchConfig, MatchEvent, PlayerIndex } from '../types';
import {
  canRequestTimeout,
  expediteAllowed,
  expediteDue,
  gameFirstServer,
  gamesNeeded,
  isGameOver,
  reduce,
} from '../engine';

const cfg = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  players: ['甲', '乙'],
  bestOf: 5,
  firstServer: 0,
  startingEnd: 0,
  ...over,
});

/** 'aab' → 甲、甲、乙 各得一分 */
const pts = (seq: string): MatchEvent[] =>
  [...seq].map((c) => ({
    type: 'POINT',
    player: (c === 'a' ? 0 : 1) as PlayerIndex,
    source: 'tap',
  }));

/** 讓某方連得 n 分 */
const run = (p: 'a' | 'b', n: number): MatchEvent[] => pts(p.repeat(n));

describe('2.11.1 一局的勝負', () => {
  it('先得 11 分且領先 2 分即獲勝', () => {
    expect(isGameOver([11, 0])).toBe(true);
    expect(isGameOver([11, 9])).toBe(true);
    expect(isGameOver([10, 9])).toBe(false);
  });

  it('10:10 之後必須淨勝 2 分', () => {
    expect(isGameOver([11, 10])).toBe(false);
    expect(isGameOver([12, 10])).toBe(true);
    expect(isGameOver([15, 14])).toBe(false);
    expect(isGameOver([16, 14])).toBe(true);
  });

  it('11:9 結束該局並累計局數', () => {
    const s = reduce(cfg(), [...pts('ab'.repeat(9)), ...run('a', 2)]); // 9:9 → 11:9
    expect(s.completedGames).toHaveLength(1);
    expect(s.completedGames[0]).toEqual({ points: [11, 9], winner: 0 });
    expect(s.gamesWon).toEqual([1, 0]);
    expect(s.points).toEqual([0, 0]);
    expect(s.gameIndex).toBe(1);
  });
});

describe('2.12.1 賽制', () => {
  it('取勝所需局數為奇數局的過半', () => {
    expect(gamesNeeded(3)).toBe(2);
    expect(gamesNeeded(5)).toBe(3);
    expect(gamesNeeded(7)).toBe(4);
  });

  it('達到所需局數即結束，之後的事件一律忽略', () => {
    const events = [...run('a', 11), ...run('a', 11), ...run('a', 11), ...run('b', 11)];
    const s = reduce(cfg(), events);
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe(0);
    expect(s.gamesWon).toEqual([3, 0]);
    expect(s.completedGames).toHaveLength(3);
  });

  it('比賽結束後畫面停在最後一局的比分', () => {
    const s = reduce(cfg({ bestOf: 3 }), [...run('a', 11), ...pts('ab'.repeat(9)), ...run('a', 2)]);
    expect(s.matchOver).toBe(true);
    expect(s.gameIndex).toBe(1);
    expect(s.points).toEqual([11, 9]);
  });
});

describe('2.13.3 發球輪轉', () => {
  it('每 2 分換發一次', () => {
    const c = cfg({ firstServer: 0 });
    const expected: PlayerIndex[] = [0, 0, 1, 1, 0, 0, 1, 1];
    expected.forEach((who, total) => {
      expect(reduce(c, run('a', total)).server).toBe(who);
    });
  });

  it('先發球者由猜先結果決定', () => {
    expect(reduce(cfg({ firstServer: 1 }), []).server).toBe(1);
    expect(reduce(cfg({ firstServer: 1 }), run('a', 2)).server).toBe(0);
  });

  it('接球者永遠是另一位選手', () => {
    const s = reduce(cfg(), run('a', 3));
    expect(s.receiver).toBe(s.server === 0 ? 1 : 0);
  });

  it('雙方同達 10 分後改為每 1 分換發', () => {
    const c = cfg({ firstServer: 0 });
    const deuce = pts('ab'.repeat(10)); // 10:10
    const at1010 = reduce(c, deuce);
    expect(at1010.points).toEqual([10, 10]);
    expect(at1010.isDeuce).toBe(true);
    expect(at1010.server).toBe(0);

    expect(reduce(c, [...deuce, ...run('a', 1)]).server).toBe(1); // 11:10
    expect(reduce(c, [...deuce, ...pts('ab')]).server).toBe(0); // 11:11
    expect(reduce(c, [...deuce, ...pts('aba')]).server).toBe(1); // 12:11
  });

  it('9:9 尚未進入 deuce，仍維持每 2 分換發', () => {
    const s = reduce(cfg(), pts('ab'.repeat(9)));
    expect(s.isDeuce).toBe(false);
    expect(s.server).toBe(1); // 總分 18 → 已換發 9 次
  });
});

describe('2.13.6 各局的首位發球者', () => {
  it('上一局先發球者，下一局先接球', () => {
    const c = cfg({ firstServer: 0 });
    expect(gameFirstServer(c, 0)).toBe(0);
    expect(gameFirstServer(c, 1)).toBe(1);
    expect(gameFirstServer(c, 2)).toBe(0);
    expect(gameFirstServer(c, 3)).toBe(1);
  });

  it('第二局開局由上一局的接球者發球', () => {
    const s = reduce(cfg({ firstServer: 0 }), run('a', 11));
    expect(s.gameIndex).toBe(1);
    expect(s.points).toEqual([0, 0]);
    expect(s.server).toBe(1);
  });
});

describe('2.13.7 方位交換', () => {
  it('每局結束交換方位', () => {
    const c = cfg({ startingEnd: 0 });
    expect(reduce(c, []).leftPlayer).toBe(0);
    expect(reduce(c, run('a', 11)).leftPlayer).toBe(1);
    expect(reduce(c, [...run('a', 11), ...run('b', 11)]).leftPlayer).toBe(0);
  });

  it('起始方位由猜先結果決定', () => {
    expect(reduce(cfg({ startingEnd: 1 }), []).leftPlayer).toBe(1);
  });

  it('決勝局一方先到 5 分時再換一次邊', () => {
    // BO3 打到第 3 局（決勝局）：甲先勝一局、乙再勝一局。
    const toDecider = [...run('a', 11), ...run('b', 11)];
    const c = cfg({ bestOf: 3, startingEnd: 0 });
    const before = reduce(c, [...toDecider, ...pts('ababab')]); // 3:3
    expect(before.isDecidingGame).toBe(true);
    expect(before.endsSwitchedInDecider).toBe(false);
    const at5 = reduce(c, [...toDecider, ...pts('ababababa')]); // 5:4
    expect(at5.endsSwitchedInDecider).toBe(true);
    expect(at5.leftPlayer).not.toBe(before.leftPlayer);
  });

  it('非決勝局到 5 分不換邊', () => {
    const s = reduce(cfg({ bestOf: 5 }), run('a', 6));
    expect(s.isDecidingGame).toBe(false);
    expect(s.endsSwitchedInDecider).toBe(false);
    expect(s.leftPlayer).toBe(0);
  });

  it('換邊與該由誰發球無關', () => {
    const toDecider = [...run('a', 11), ...run('b', 11)];
    const c = cfg({ bestOf: 3, startingEnd: 0, firstServer: 0 });
    // 乙先到 5 分（0:5），此時發球權仍照每 2 分輪轉。
    const s = reduce(c, [...toDecider, ...run('b', 5)]);
    expect(s.endsSwitchedInDecider).toBe(true);
    expect(s.server).toBe(gameFirstServer(c, 2) === 0 ? 0 : 1);
  });
});

describe('2.15 輪換發球法', () => {
  const c = cfg({ firstServer: 0 });

  it('球在比賽中時，由原發球者續發，其後每 1 分換發', () => {
    const base = pts('ababababa'); // 5:4，總分 9 → 發球者為甲
    expect(reduce(c, base).server).toBe(0);
    const on: MatchEvent[] = [...base, { type: 'EXPEDITE_ON', ballInPlay: true }];
    const s = reduce(c, on);
    expect(s.expedite).toBe(true);
    expect(s.server).toBe(0);
    expect(reduce(c, [...on, ...run('a', 1)]).server).toBe(1);
    expect(reduce(c, [...on, ...run('a', 2)]).server).toBe(0);
  });

  it('球不在比賽中時，改由上一分的接球者發球', () => {
    const base = pts('ababababa');
    const on: MatchEvent[] = [...base, { type: 'EXPEDITE_ON', ballInPlay: false }];
    expect(reduce(c, on).server).toBe(1);
    expect(reduce(c, [...on, ...run('a', 1)]).server).toBe(0);
  });

  it('一旦啟動即延續到本場結束，後續各局從開局起每 1 分換發', () => {
    const on: MatchEvent[] = [
      ...pts('ababababa'),
      { type: 'EXPEDITE_ON', ballInPlay: false },
      ...run('a', 6), // 5:4 → 11:4，本局結束
    ];
    const s = reduce(c, on);
    expect(s.gameIndex).toBe(1);
    expect(s.expedite).toBe(true);
    expect(s.server).toBe(gameFirstServer(c, 1));
    expect(reduce(c, [...on, ...run('a', 1)]).server).toBe(gameFirstServer(c, 1) === 0 ? 1 : 0);
  });

  it('重複啟動不會改變已記錄的啟動點', () => {
    const on: MatchEvent[] = [
      ...pts('ababababa'),
      { type: 'EXPEDITE_ON', ballInPlay: false },
      { type: 'EXPEDITE_ON', ballInPlay: true },
    ];
    expect(reduce(c, on).expediteInfo).toEqual({
      gameIndex: 0,
      totalAtStart: 9,
      serverAtStart: 1,
    });
  });

  it('該局合計已達 18 分即不得啟動（2.15.2）', () => {
    expect(expediteAllowed(reduce(c, pts('ab'.repeat(8))))).toBe(true); // 16 分
    expect(expediteAllowed(reduce(c, pts('ab'.repeat(9))))).toBe(false); // 18 分
  });

  it('滿 10 分鐘才算達到自動啟動時機（2.15.1）', () => {
    const s = reduce(c, pts('abab'));
    expect(expediteDue(s, 9 * 60 * 1000)).toBe(false);
    expect(expediteDue(s, 10 * 60 * 1000)).toBe(true);
  });

  it('已啟動或比賽結束後不再提示', () => {
    const on = reduce(c, [...pts('abab'), { type: 'EXPEDITE_ON', ballInPlay: false }]);
    expect(expediteAllowed(on)).toBe(false);
    const done = reduce(cfg({ bestOf: 3 }), [...run('a', 11), ...run('a', 11)]);
    expect(expediteAllowed(done)).toBe(false);
  });
});

describe('局點與賽末點', () => {
  it('10:5 為甲的局點', () => {
    const s = reduce(cfg(), pts('aaaaaaaaaabbbbb'));
    expect(s.points).toEqual([10, 5]);
    expect(s.gamePointFor).toBe(0);
    expect(s.matchPointFor).toBeNull();
  });

  it('10:10 雙方都不算局點', () => {
    expect(reduce(cfg(), pts('ab'.repeat(10))).gamePointFor).toBeNull();
  });

  it('11:10 為領先方的局點', () => {
    const s = reduce(cfg(), [...pts('ab'.repeat(10)), ...run('a', 1)]);
    expect(s.gamePointFor).toBe(0);
  });

  it('第三局 10:5 且已拿下兩局時為賽末點', () => {
    const s = reduce(cfg(), [...run('a', 11), ...run('a', 11), ...pts('aaaaaaaaaabbbbb')]);
    expect(s.gamesWon).toEqual([2, 0]);
    expect(s.matchPointFor).toBe(0);
  });
});

describe('3.4.4 間歇與暫停', () => {
  it('每累計 6 分提示擦汗', () => {
    expect(reduce(cfg(), pts('ababab')).towelBreakDue).toBe(true);
    expect(reduce(cfg(), pts('ababa')).towelBreakDue).toBe(false);
    expect(reduce(cfg(), pts('ab'.repeat(6))).towelBreakDue).toBe(true);
    expect(reduce(cfg(), []).towelBreakDue).toBe(false);
  });

  it('每方每場限用一次暫停', () => {
    const s0 = reduce(cfg(), []);
    expect(canRequestTimeout(s0, 0)).toBe(true);
    const s1 = reduce(cfg(), [{ type: 'TIMEOUT', player: 0 }]);
    expect(s1.timeoutsUsed).toEqual([true, false]);
    expect(canRequestTimeout(s1, 0)).toBe(false);
    expect(canRequestTimeout(s1, 1)).toBe(true);
  });
});

describe('2.14 錯序、錯邊與 Undo', () => {
  it('砍掉最後一個事件即可完整回復上一個狀態', () => {
    const events = pts('aabbaba');
    const before = reduce(cfg(), events.slice(0, -1));
    const after = reduce(cfg(), events);
    expect(after.points).not.toEqual(before.points);
    expect(reduce(cfg(), events.slice(0, -1))).toEqual(before);
  });

  it('跨越局界的 Undo 會正確回到上一局的賽末分數', () => {
    const events = [...run('a', 11), ...run('b', 1)];
    const undone = reduce(cfg(), events.slice(0, -1));
    expect(undone.gameIndex).toBe(1);
    expect(undone.points).toEqual([0, 0]);
    const twice = reduce(cfg(), events.slice(0, -2));
    expect(twice.gameIndex).toBe(0);
    expect(twice.points).toEqual([10, 0]);
    expect(twice.completedGames).toHaveLength(0);
  });

  it('所有得分在重播後保持一致（2.14.3 已得分數全部有效）', () => {
    const events = pts('ab'.repeat(12)); // 12:12
    const s = reduce(cfg(), events);
    expect(s.points).toEqual([12, 12]);
    expect(s.completedGames).toHaveLength(0);
  });
});

describe('完整賽局重播', () => {
  it('BO5 打滿五局，決勝局換邊與局數統計皆正確', () => {
    const bestOf: BestOf = 5;
    const events = [
      ...run('a', 11), // 1-0
      ...run('b', 11), // 1-1
      ...run('a', 11), // 2-1
      ...run('b', 11), // 2-2
      ...pts('ababab'), // 決勝局 3:3
    ];
    const s = reduce(cfg({ bestOf }), events);
    expect(s.gamesWon).toEqual([2, 2]);
    expect(s.gameIndex).toBe(4);
    expect(s.isDecidingGame).toBe(true);
    expect(s.matchOver).toBe(false);

    const decided = reduce(cfg({ bestOf }), [...events, ...run('b', 8)]);
    expect(decided.matchOver).toBe(true);
    expect(decided.winner).toBe(1);
    expect(decided.gamesWon).toEqual([2, 3]);
  });
});
