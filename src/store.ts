import { DEFAULT_VOCAB } from './audio/stt';
import type { Vocabulary } from './audio/stt';
import type { BestOf, MatchConfig, MatchEvent, PlayerIndex } from './rules/types';

const MATCH_KEY = 'pingpong-scoreboard/v1';
const PREFS_KEY = 'pingpong-scoreboard/prefs/v1';

export interface SavedMatch {
  config: MatchConfig;
  events: MatchEvent[];
  savedAt: number;
}

export function save(config: MatchConfig, events: readonly MatchEvent[]): void {
  try {
    const payload: SavedMatch = { config, events: [...events], savedAt: Date.now() };
    localStorage.setItem(MATCH_KEY, JSON.stringify(payload));
  } catch {
    // 私密瀏覽或關閉站台資料時會擲出例外，續賽只是便利功能，忽略即可。
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(MATCH_KEY);
  } catch {
    /* 同上 */
  }
}

/** 讀回上一場比賽。格式不符時一律回傳 null，避免舊資料讓畫面壞掉。 */
export function load(): SavedMatch | null {
  try {
    const raw = localStorage.getItem(MATCH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!isSaved(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function isSaved(v: unknown): v is SavedMatch {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const c = o.config as Record<string, unknown> | undefined;
  if (!c || !Array.isArray(o.events) || !Array.isArray(c.players)) return false;
  if (c.players.length !== 2 || !c.players.every((p) => typeof p === 'string')) return false;
  if (![3, 5, 7].includes(c.bestOf as BestOf)) return false;
  if (![0, 1].includes(c.firstServer as PlayerIndex)) return false;
  if (![0, 1].includes(c.startingEnd as PlayerIndex)) return false;
  return o.events.every(isEvent);
}

function isEvent(v: unknown): v is MatchEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  switch (e.type) {
    case 'POINT':
      return e.player === 0 || e.player === 1;
    case 'TIMEOUT':
      return e.player === 0 || e.player === 1;
    case 'EXPEDITE_ON':
      return typeof e.ballInPlay === 'boolean';
    default:
      return false;
  }
}

// ── 偏好設定 ────────────────────────────────────────────────
//
// 與賽事記錄分開存放：清除比賽（新比賽）不應該把使用者的設定一起洗掉。

export interface Prefs {
  players: [string, string];
  bestOf: BestOf;
  firstServer: PlayerIndex;
  startingEnd: PlayerIndex;
  /** 語音播報開關 */
  tts: boolean;
  /** 語音計分開關 */
  stt: boolean;
  /** 耳機媒體鍵計分開關（上一曲 = 左方得分、下一曲 = 右方得分） */
  mediaKeys: boolean;
  /** 指定的播報語音；null 代表自動挑選中文語音。 */
  voiceURI: string | null;
  /** 播報語速。 */
  rate: number;
  /** 自訂的語音計分指令。 */
  vocab: Vocabulary;
  /** 資料版本。用來把新的預設值套到舊資料上，其餘設定照舊保留。 */
  schema: number;
}

export const DEFAULT_PREFS: Prefs = {
  players: ['選手 A', '選手 B'],
  bestOf: 5,
  firstServer: 0,
  startingEnd: 0,
  tts: true,
  stt: true,
  mediaKeys: false,
  voiceURI: null,
  rate: 1.05,
  vocab: DEFAULT_VOCAB,
  schema: 2,
};

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 同上 */
  }
}

/** 讀回上次使用的選項。缺欄位一律以預設值補齊，舊版資料也能沿用。 */
export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const v = JSON.parse(raw) as Partial<Prefs> | null;
    if (typeof v !== 'object' || v === null) return { ...DEFAULT_PREFS };
    const schema = typeof v.schema === 'number' ? v.schema : 1;

    const players = Array.isArray(v.players) && v.players.length === 2 &&
      v.players.every((p) => typeof p === 'string')
      ? ([v.players[0], v.players[1]] as [string, string])
      : DEFAULT_PREFS.players;

    return {
      players,
      bestOf: [3, 5, 7].includes(v.bestOf as number) ? (v.bestOf as BestOf) : DEFAULT_PREFS.bestOf,
      firstServer: v.firstServer === 1 ? 1 : 0,
      startingEnd: v.startingEnd === 1 ? 1 : 0,
      tts: typeof v.tts === 'boolean' ? v.tts : DEFAULT_PREFS.tts,
      // v1 的語音計分預設是關的；v2 起改為進入比賽自動開啟，因此舊資料
      // 的 stt 一律丟掉、改用新預設，其餘設定原封不動保留。
      stt: schema >= 2 && typeof v.stt === 'boolean' ? v.stt : DEFAULT_PREFS.stt,
      mediaKeys: typeof v.mediaKeys === 'boolean' ? v.mediaKeys : DEFAULT_PREFS.mediaKeys,
      voiceURI: typeof v.voiceURI === 'string' && v.voiceURI ? v.voiceURI : null,
      rate: typeof v.rate === 'number' && v.rate >= 0.6 && v.rate <= 1.6 ? v.rate : DEFAULT_PREFS.rate,
      vocab: readVocab(v.vocab),
      schema: DEFAULT_PREFS.schema,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 任一類別若空掉或格式不符，就回退成該類別的預設詞，避免整組指令失效。 */
function readVocab(v: unknown): Vocabulary {
  const src = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<keyof Vocabulary, unknown>>;
  const pick = (key: keyof Vocabulary): string[] => {
    const list = src[key];
    if (!Array.isArray(list)) return [...DEFAULT_VOCAB[key]];
    const clean = list.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
    return clean.length > 0 ? clean : [...DEFAULT_VOCAB[key]];
  };
  return {
    left: pick('left'),
    right: pick('right'),
    undo: pick('undo'),
    timeout: pick('timeout'),
    point: pick('point'),
  };
}
