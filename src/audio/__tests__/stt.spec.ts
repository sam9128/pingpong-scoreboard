import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB, formatPhrases, matchCommand, normalize, parsePhrases } from '../stt';
import type { Vocabulary } from '../stt';

const NAMES: [string, string] = ['王小明', '李大華'];

describe('normalize', () => {
  it('去掉空白與標點', () => {
    expect(normalize('左邊，得分。')).toBe('左邊得分');
    expect(normalize(' 右 邊 ')).toBe('右邊');
  });
});

describe('matchCommand', () => {
  it('辨識左右得分', () => {
    expect(matchCommand('左邊得分', NAMES)).toEqual({ kind: 'point', side: 'left' });
    expect(matchCommand('右邊得分', NAMES)).toEqual({ kind: 'point', side: 'right' });
    expect(matchCommand('左', NAMES)).toEqual({ kind: 'point', side: 'left' });
    expect(matchCommand('右邊', NAMES)).toEqual({ kind: 'point', side: 'right' });
  });

  it('辨識選手姓名，且優先於左右', () => {
    expect(matchCommand('王小明得分', NAMES)).toEqual({ kind: 'pointByPlayer', player: 0 });
    expect(matchCommand('李大華', NAMES)).toEqual({ kind: 'pointByPlayer', player: 1 });
    expect(matchCommand('左邊的王小明得分', NAMES)).toEqual({ kind: 'pointByPlayer', player: 0 });
  });

  it('兩位選手同時命中時視為無法判斷', () => {
    expect(matchCommand('小明對小明華得分', ['小明', '小明華'])).toBeNull();
  });

  it('撤銷指令優先於一切', () => {
    for (const word of ['取消', '撤銷', '不算', '重來']) {
      expect(matchCommand(word, NAMES)).toEqual({ kind: 'undo' });
    }
    // 即使句子裡同時出現「左邊」，撤銷仍然優先。
    expect(matchCommand('左邊那分取消', NAMES)).toEqual({ kind: 'undo' });
  });

  it('暫停必須指明是哪一側', () => {
    expect(matchCommand('左邊暫停', NAMES)).toEqual({ kind: 'timeout', side: 'left' });
    expect(matchCommand('暫停', NAMES)).toBeNull();
  });

  it('沒指明是誰的「得分」不動作', () => {
    expect(matchCommand('得分', NAMES)).toBeNull();
  });

  it('沒有明說「得分」的長句一律忽略，避免場邊閒聊誤觸', () => {
    expect(matchCommand('那顆球從左邊擦網過去真的很可惜', NAMES)).toBeNull();
    // 但明講得分就採信。
    expect(matchCommand('剛剛那球算左邊得分', NAMES)).toEqual({ kind: 'point', side: 'left' });
  });

  it('空字串與雜訊回傳 null', () => {
    expect(matchCommand('', NAMES)).toBeNull();
    expect(matchCommand('嗯嗯', NAMES)).toBeNull();
  });
});

describe('自訂指令詞彙', () => {
  it('parsePhrases 接受頓號、逗號、分號與空白', () => {
    expect(parsePhrases('紅方、藍方, 白方; 黑方 綠方')).toEqual([
      '紅方',
      '藍方',
      '白方',
      '黑方',
      '綠方',
    ]);
    expect(parsePhrases('  ')).toEqual([]);
  });

  it('formatPhrases 與 parsePhrases 互為逆運算', () => {
    const list = ['紅方', '藍方'];
    expect(parsePhrases(formatPhrases(list))).toEqual(list);
  });

  it('自訂詞彙會取代預設詞', () => {
    const vocab: Vocabulary = {
      ...DEFAULT_VOCAB,
      left: ['紅方'],
      right: ['藍方'],
      undo: ['喊卡'],
    };
    expect(matchCommand('紅方', NAMES, vocab)).toEqual({ kind: 'point', side: 'left' });
    expect(matchCommand('藍方得分', NAMES, vocab)).toEqual({ kind: 'point', side: 'right' });
    expect(matchCommand('喊卡', NAMES, vocab)).toEqual({ kind: 'undo' });
    // 預設詞已被換掉，不應再生效
    expect(matchCommand('左邊', NAMES, vocab)).toBeNull();
    expect(matchCommand('取消', NAMES, vocab)).toBeNull();
  });

  it('自訂暫停詞仍需指明是哪一側', () => {
    const vocab: Vocabulary = { ...DEFAULT_VOCAB, timeout: ['休息'], left: ['紅方'] };
    expect(matchCommand('紅方休息', NAMES, vocab)).toEqual({ kind: 'timeout', side: 'left' });
    expect(matchCommand('休息', NAMES, vocab)).toBeNull();
  });

  it('自訂的明確計分詞可讓長句也被採信', () => {
    const vocab: Vocabulary = { ...DEFAULT_VOCAB, point: ['算一分'] };
    expect(matchCommand('剛剛那顆球左邊算一分', NAMES, vocab)).toEqual({
      kind: 'point',
      side: 'left',
    });
    expect(matchCommand('剛剛那顆球左邊得分', NAMES, vocab)).toBeNull();
  });

  it('沒帶 vocab 時沿用預設，維持既有行為', () => {
    expect(matchCommand('左邊得分', NAMES)).toEqual({ kind: 'point', side: 'left' });
  });
});
