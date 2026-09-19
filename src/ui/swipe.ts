/**
 * 畫面滑動手勢的設定與判定。
 *
 * 判定做成純函式，不碰 DOM —— 這一段的門檻全是經驗值，唯有能單獨餵資料
 * 進去跑，才擋得住日後「順手」把某個數字改小的衝動。
 */

/** 四個方向就是全部的輸入空間，因此對應表以方向為鍵。 */
export type SwipeDir = 'left' | 'right' | 'up' | 'down';

/** 一個方向可以指派的動作。 */
export type SwipeAction = 'none' | 'scoreLeft' | 'scoreRight' | 'undo' | 'redo';

export type SwipeMap = Record<SwipeDir, SwipeAction>;

export const DEFAULT_SWIPE_MAP: SwipeMap = {
  left: 'scoreLeft',
  right: 'scoreRight',
  up: 'undo',
  down: 'redo',
};

export const SWIPE_DIR_LABELS: Record<SwipeDir, string> = {
  left: '向左滑',
  right: '向右滑',
  up: '向上滑',
  down: '向下滑',
};

export const SWIPE_ACTION_LABELS: Record<SwipeAction, string> = {
  none: '不指定',
  scoreLeft: '左邊加分',
  scoreRight: '右邊加分',
  undo: '復原上一步',
  redo: '重做',
};

/**
 * 滑動要走多遠才算數。
 *
 * 記分時手指是點下去就起來，本來就會有一點位移；開得太小會把點擊誤判成
 * 滑動，那比沒有這個手勢還糟 —— 使用者會看到分加到另一邊去。
 */
export const SWIPE_MIN_PX = 56;
/** 主方向要比另一個方向長這麼多倍，斜著滑不算，免得加分變成復原。 */
export const SWIPE_RATIO = 1.6;
/** 超過這個時間就不是滑動，是按著不放之後才鬆手。 */
export const SWIPE_MAX_MS = 900;

/**
 * 這一下是什麼：
 * - `tap`     位移太小，是點擊，交給原本的點擊處理
 * - `unclear` 走得夠遠但判不出方向（斜著滑、或拖太久），吃掉不做事
 * - 方向      確定是那個方向的滑動
 */
export type SwipeVerdict = SwipeDir | 'tap' | 'unclear';

export function readSwipe(dx: number, dy: number, ms: number): SwipeVerdict {
  const [adx, ady] = [Math.abs(dx), Math.abs(dy)];
  const major = Math.max(adx, ady);
  if (major < SWIPE_MIN_PX) return 'tap';

  // 走了這麼遠就不是點擊了。以下每一條都回 unclear 而不是 tap ——
  // 斜著滑一段距離卻加了分，比什麼都沒發生更難接受。
  if (ms > SWIPE_MAX_MS) return 'unclear';
  if (major < Math.min(adx, ady) * SWIPE_RATIO) return 'unclear';

  if (adx >= ady) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
