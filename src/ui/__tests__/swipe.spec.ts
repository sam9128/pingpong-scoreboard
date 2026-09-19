import { describe, expect, it } from 'vitest';
import { SWIPE_MAX_MS, SWIPE_MIN_PX, readSwipe } from '../swipe';

/**
 * 這組測試守的是「誤判的代價不對稱」。
 *
 * 把滑動判成點擊，最多是手勢沒生效、再滑一次；把點擊判成滑動，分會加到
 * 另一邊去，而記分的人多半要等到看比分才發現。因此所有邊界都往保守的
 * 那一側靠：拿不準就不要動作。
 */
describe('readSwipe', () => {
  it('四個方向各自認得出來', () => {
    expect(readSwipe(-120, 0, 200)).toBe('left');
    expect(readSwipe(120, 0, 200)).toBe('right');
    expect(readSwipe(0, -120, 200)).toBe('up');
    expect(readSwipe(0, 120, 200)).toBe('down');
  });

  it('位移太小就是點擊 —— 點下去本來就會有一點晃動', () => {
    expect(readSwipe(0, 0, 40)).toBe('tap');
    expect(readSwipe(12, 9, 60)).toBe('tap');
    expect(readSwipe(SWIPE_MIN_PX - 1, 0, 100)).toBe('tap');
  });

  it('剛好走到門檻就算滑動', () => {
    expect(readSwipe(SWIPE_MIN_PX, 0, 100)).toBe('right');
  });

  it('斜著滑判不出方向，寧可什麼都不做', () => {
    // 90 / 80 = 1.125，不到 1.6 倍
    expect(readSwipe(90, 80, 200)).toBe('unclear');
    expect(readSwipe(-100, 90, 200)).toBe('unclear');
  });

  it('按著不放很久才鬆手不算滑動', () => {
    expect(readSwipe(-200, 0, SWIPE_MAX_MS + 1)).toBe('unclear');
  });

  it('走遠了就絕對不會被當成點擊 —— 那一下不可以又加一分', () => {
    for (const [dx, dy, ms] of [
      [90, 80, 200],
      [-200, 0, 5000],
      [0, 300, 4000],
      [70, 60, 1500],
    ]) {
      expect(readSwipe(dx!, dy!, ms!)).not.toBe('tap');
    }
  });
});
