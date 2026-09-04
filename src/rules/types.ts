/**
 * 資料模型 — 依據 ITTF Handbook 2021 v2，第 2.11 ~ 2.15 條與 3.4.4 條。
 *
 * 設計原則：事件溯源（event sourcing）。
 * 唯一的真實來源是 MatchEvent[]，所有比分／發球權／方位都由 reduce() 重新計算，
 * 因此 Undo 只需要砍掉最後一個事件，續賽只需要把事件陣列存起來。
 */

/** 選手索引。0 與 1 是選手「身分」，與場地左右無關（左右會隨換邊改變）。 */
export type PlayerIndex = 0 | 1;

/** 賽制局數，2.12.1 規定為奇數局。 */
export type BestOf = 3 | 5 | 7;

/** 這一分是怎麼被記錄的，供 UI 顯示「語音計分可撤銷」提示用。 */
export type PointSource = 'tap' | 'key' | 'voice';

export interface MatchConfig {
  players: [string, string];
  bestOf: BestOf;
  /** 猜先結果（2.13.1）：第一局由誰先發球。 */
  firstServer: PlayerIndex;
  /** 第一局開始時 players[0] 站在哪一側。0 = 畫面左側、1 = 畫面右側。 */
  startingEnd: PlayerIndex;
}

export type MatchEvent =
  | { type: 'POINT'; player: PlayerIndex; source: PointSource }
  /**
   * 啟動輪換發球法（2.15）。
   * ballInPlay 對應 2.15.3：時間到時球仍在比賽中 → 由該回合的發球者續發；
   * 球不在比賽中 → 由上一回合的接球者發球。
   */
  | { type: 'EXPEDITE_ON'; ballInPlay: boolean }
  /** 暫停（3.4.4.2），每方每場限一次。 */
  | { type: 'TIMEOUT'; player: PlayerIndex };

export interface GameResult {
  points: [number, number];
  winner: PlayerIndex;
}

export interface ExpediteInfo {
  /** 在第幾局啟動（0-based）。 */
  gameIndex: number;
  /** 啟動當下該局的總分數。 */
  totalAtStart: number;
  /** 啟動後第一個發球者。 */
  serverAtStart: PlayerIndex;
}

export interface MatchState {
  config: MatchConfig;

  /** 已完成的各局結果。 */
  completedGames: GameResult[];
  /** 各選手已取得的局數。 */
  gamesWon: [number, number];
  /** 取勝所需局數，(bestOf + 1) / 2。 */
  gamesNeeded: number;

  /** 目前進行到第幾局（0-based）。比賽結束後停在最後一局。 */
  gameIndex: number;
  /** 本局比分。 */
  points: [number, number];

  /** 目前發球者（2.13.3）。 */
  server: PlayerIndex;
  /** 目前接球者。 */
  receiver: PlayerIndex;
  /** 目前站在畫面左側的選手（2.13.7）。 */
  leftPlayer: PlayerIndex;

  /** 是否已進入 deuce（雙方皆達 10 分），此時改為每 1 分換發。 */
  isDeuce: boolean;
  /** 輪換發球法是否已生效；一旦啟動即延續到本場結束（2.15.6）。 */
  expedite: boolean;
  /** 輪換發球法的啟動細節，未啟動為 null。 */
  expediteInfo: ExpediteInfo | null;

  /** 暫停使用狀況（3.4.4.2）。 */
  timeoutsUsed: [boolean, boolean];

  /** 誰在局點上；無人則為 null。 */
  gamePointFor: PlayerIndex | null;
  /** 誰在賽末點上；無人則為 null。 */
  matchPointFor: PlayerIndex | null;

  /** 是否為決勝局（最後一個可能的局）。 */
  isDecidingGame: boolean;
  /** 決勝局是否已因一方先到 5 分而換過邊（2.13.7）。 */
  endsSwitchedInDecider: boolean;
  /** 是否剛好落在每 6 分的擦汗間歇上（3.4.4.1.2）。 */
  towelBreakDue: boolean;

  matchOver: boolean;
  winner: PlayerIndex | null;
}
