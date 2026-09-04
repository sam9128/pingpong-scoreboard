/**
 * 計分規則引擎 — ITTF Handbook 2021 v2。
 * 本檔完全不碰 DOM，所有函式皆為純函式，可獨立測試。
 */
import type {
  BestOf,
  ExpediteInfo,
  GameResult,
  MatchConfig,
  MatchEvent,
  MatchState,
  PlayerIndex,
} from './types';

/** 2.11.1 一局先得 11 分。 */
export const GAME_TARGET = 11;
/** 2.11.1 雙方同達 10 分後須淨勝 2 分。 */
export const DEUCE_AT = 10;
/** 2.15.1 一局進行滿 10 分鐘啟動輪換發球法。 */
export const EXPEDITE_AFTER_MS = 10 * 60 * 1000;
/** 2.15.2 該局合計已達 18 分則不啟動。 */
export const EXPEDITE_POINT_CEILING = 18;
/** 2.15.4 接發方成功回擊 13 板即得分。 */
export const EXPEDITE_RETURN_LIMIT = 13;
/** 2.13.7 決勝局一方先到 5 分時換邊。 */
export const DECIDER_SWITCH_AT = 5;
/** 3.4.4.1.2 每累計 6 分可擦汗。 */
export const TOWEL_BREAK_EVERY = 6;
/** 3.4.4.2 每方每場一次、每次 1 分鐘的暫停。 */
export const TIMEOUT_MS = 60 * 1000;
/** 3.4.4.1.1 局間休息上限 1 分鐘。 */
export const GAME_BREAK_MS = 60 * 1000;

export const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

/** 取勝所需局數。BO5 → 3。 */
export const gamesNeeded = (bestOf: BestOf): number => (bestOf + 1) / 2;

/** 2.11.1 判斷一局是否已分出勝負。 */
export function isGameOver(points: readonly [number, number]): boolean {
  const [a, b] = points;
  return (a >= GAME_TARGET || b >= GAME_TARGET) && Math.abs(a - b) >= 2;
}

/**
 * 2.13.6 上一局先發球者，下一局先接球 —— 因此每局的首位發球者輪流交換。
 */
export function gameFirstServer(config: MatchConfig, gameIndex: number): PlayerIndex {
  return ((config.firstServer + gameIndex) % 2) as PlayerIndex;
}

/**
 * 2.13.3 發球權計算。
 *
 * 一般狀況每 2 分換發；雙方同達 10 分（deuce）或輪換發球法生效後，改為每 1 分換發，
 * 但發接順序本身不變。
 */
export function serverAt(
  config: MatchConfig,
  gameIndex: number,
  points: readonly [number, number],
  expediteInfo: ExpediteInfo | null,
  expediteInForce: boolean,
): PlayerIndex {
  const [a, b] = points;
  const total = a + b;
  const first = gameFirstServer(config, gameIndex);

  // 在「啟動輪換發球法的那一局」，從啟動當下的比分往後每 1 分換發。
  if (expediteInfo && expediteInfo.gameIndex === gameIndex) {
    const since = total - expediteInfo.totalAtStart;
    return ((expediteInfo.serverAtStart + since) % 2) as PlayerIndex;
  }

  // 2.15.6 輪換發球法延續到本場結束：後續各局從開局起就是每 1 分換發。
  if (expediteInForce) {
    return ((first + total) % 2) as PlayerIndex;
  }

  // 未進入 deuce 前每 2 分換發；進入 deuce 後（total 必為 20）改為每 1 分。
  const changes = a >= DEUCE_AT && b >= DEUCE_AT ? DEUCE_AT + (total - 2 * DEUCE_AT) : Math.floor(total / 2);
  return ((first + changes) % 2) as PlayerIndex;
}

/**
 * 2.13.7 方位計算。
 *
 * 每局交換方位；決勝局中任一方先到 5 分時再換一次（與發球輪次無關）。
 * 回傳目前站在畫面左側的選手。
 */
export function leftPlayerAt(
  config: MatchConfig,
  gameIndex: number,
  points: readonly [number, number],
  isDecidingGame: boolean,
): PlayerIndex {
  let sideOfPlayer0 = (config.startingEnd + gameIndex) % 2;
  if (isDecidingGame && (points[0] >= DECIDER_SWITCH_AT || points[1] >= DECIDER_SWITCH_AT)) {
    sideOfPlayer0 ^= 1;
  }
  return (sideOfPlayer0 === 0 ? 0 : 1) as PlayerIndex;
}

interface Core {
  completedGames: GameResult[];
  gameIndex: number;
  points: [number, number];
  expediteInfo: ExpediteInfo | null;
  expediteInForce: boolean;
  timeoutsUsed: [boolean, boolean];
}

function tallyGames(completed: readonly GameResult[]): [number, number] {
  const won: [number, number] = [0, 0];
  for (const g of completed) won[g.winner]++;
  return won;
}

/**
 * 把事件串重播成完整比賽狀態。
 * 比賽結束後的多餘事件會被忽略，避免 UI 誤觸造成狀態不一致。
 */
export function reduce(config: MatchConfig, events: readonly MatchEvent[]): MatchState {
  const need = gamesNeeded(config.bestOf);
  const core: Core = {
    completedGames: [],
    gameIndex: 0,
    points: [0, 0],
    expediteInfo: null,
    expediteInForce: false,
    timeoutsUsed: [false, false],
  };

  for (const ev of events) {
    const won = tallyGames(core.completedGames);
    if (won[0] >= need || won[1] >= need) break;

    switch (ev.type) {
      case 'POINT': {
        core.points[ev.player]++;
        if (isGameOver(core.points)) {
          const winner: PlayerIndex = core.points[0] > core.points[1] ? 0 : 1;
          core.completedGames.push({ points: [core.points[0], core.points[1]], winner });
          core.gameIndex++;
          core.points = [0, 0];
        }
        break;
      }
      case 'EXPEDITE_ON': {
        // 2.15.6：只有第一次啟動有效，之後整場維持。
        if (core.expediteInForce) break;
        const current = serverAt(config, core.gameIndex, core.points, core.expediteInfo, false);
        core.expediteInForce = true;
        core.expediteInfo = {
          gameIndex: core.gameIndex,
          totalAtStart: core.points[0] + core.points[1],
          // 2.15.3：球在比賽中 → 原發球者續發；球不在比賽中 → 改由上一分的接球者發球。
          serverAtStart: ev.ballInPlay ? current : other(current),
        };
        break;
      }
      case 'TIMEOUT': {
        core.timeoutsUsed[ev.player] = true;
        break;
      }
    }
  }

  const gamesWon = tallyGames(core.completedGames);
  const matchOver = gamesWon[0] >= need || gamesWon[1] >= need;
  const winner: PlayerIndex | null = matchOver ? (gamesWon[0] >= need ? 0 : 1) : null;

  // 比賽結束時停留在最後一局的畫面上。
  const gameIndex = matchOver ? core.gameIndex - 1 : core.gameIndex;
  const points: [number, number] = matchOver
    ? [...core.completedGames[core.completedGames.length - 1]!.points]
    : [core.points[0], core.points[1]];

  const isDecidingGame = gameIndex === config.bestOf - 1;
  const server = serverAt(config, gameIndex, points, core.expediteInfo, core.expediteInForce);
  const leftPlayer = leftPlayerAt(config, gameIndex, points, isDecidingGame);

  const total = points[0] + points[1];
  const isDeuce = points[0] >= DEUCE_AT && points[1] >= DEUCE_AT;

  const gamePointFor = matchOver ? null : gamePointHolder(points);
  const matchPointFor =
    gamePointFor !== null && gamesWon[gamePointFor] + 1 >= need ? gamePointFor : null;

  return {
    config,
    completedGames: core.completedGames,
    gamesWon,
    gamesNeeded: need,
    gameIndex,
    points,
    server,
    receiver: other(server),
    leftPlayer,
    isDeuce,
    expedite: core.expediteInForce,
    expediteInfo: core.expediteInfo,
    timeoutsUsed: core.timeoutsUsed,
    gamePointFor,
    matchPointFor,
    isDecidingGame,
    endsSwitchedInDecider:
      isDecidingGame && (points[0] >= DECIDER_SWITCH_AT || points[1] >= DECIDER_SWITCH_AT),
    towelBreakDue: !matchOver && total > 0 && total % TOWEL_BREAK_EVERY === 0,
    matchOver,
    winner,
  };
}

/** 誰再得 1 分就贏得本局。 */
function gamePointHolder(points: readonly [number, number]): PlayerIndex | null {
  for (const p of [0, 1] as const) {
    const mine = points[p] + 1;
    const theirs = points[other(p)];
    if (mine >= GAME_TARGET && mine - theirs >= 2) return p;
  }
  return null;
}

/**
 * 2.15.1 + 2.15.2 是否「可以」啟動輪換發球法。
 * 雙方合意時可隨時啟動，但該局合計已達 18 分則一律不得啟動。
 */
export function expediteAllowed(state: MatchState): boolean {
  if (state.expedite || state.matchOver) return false;
  return state.points[0] + state.points[1] < EXPEDITE_POINT_CEILING;
}

/** 2.15.1 是否「已達自動啟動時機」（本局已進行滿 10 分鐘）。 */
export function expediteDue(state: MatchState, gameElapsedMs: number): boolean {
  return expediteAllowed(state) && gameElapsedMs >= EXPEDITE_AFTER_MS;
}

/** 3.4.4.2 該方是否還能請求暫停。 */
export function canRequestTimeout(state: MatchState, player: PlayerIndex): boolean {
  return !state.matchOver && !state.timeoutsUsed[player];
}

/** 目前局數以「第 N 局」的人類說法呈現。 */
export const gameNumber = (state: MatchState): number => state.gameIndex + 1;
