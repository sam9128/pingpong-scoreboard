import {
  EXPEDITE_RETURN_LIMIT,
  GAME_BREAK_MS,
  isGameOver,
  TIMEOUT_MS,
  canRequestTimeout,
  expediteAllowed,
  expediteDue,
  other,
  reduce,
} from '../rules/engine';
import type {
  BestOf,
  MatchConfig,
  MatchEvent,
  MatchState,
  PlayerIndex,
  PointSource,
} from '../rules/types';
import { Announcer } from '../audio/tts';
import { DEFAULT_VOCAB, VoiceScorer, formatPhrases, parsePhrases } from '../audio/stt';
import type { Side, VoiceCommand, Vocabulary } from '../audio/stt';
import * as store from '../store';
import { createWakeLock } from '../wakelock';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

const BEST_OF_LABEL: Record<BestOf, string> = {
  3: '三局兩勝',
  5: '五局三勝',
  7: '七局四勝',
};

/** 自訂指令欄位與 Vocabulary 欄位的對應。 */
const VOCAB_FIELDS: [keyof Vocabulary, string][] = [
  ['left', 'vocLeft'],
  ['right', 'vocRight'],
  ['undo', 'vocUndo'],
  ['timeout', 'vocTimeout'],
  ['point', 'vocPoint'],
];

/** 雙擊判定的時間窗。太長會把連續得分誤判成雙擊，太短則不好按。 */
const DOUBLE_TAP_MS = 260;

interface ModalAction {
  label: string;
  accent?: boolean;
  onClick: () => void;
}

export class App {
  private config: MatchConfig = {
    players: ['選手 A', '選手 B'],
    bestOf: 5,
    firstServer: 0,
    startingEnd: 0,
  };

  private events: MatchEvent[] = [];
  private redoStack: MatchEvent[] = [];
  private state: MatchState = reduce(this.config, []);

  /** 輪換發球法的接發方回擊板數（屬於當下這一個回合，不進事件記錄）。 */
  private rally = 0;

  /** 本局已進行時間，供 2.15.1 的 10 分鐘判定使用；暫停期間不計。 */
  private elapsedBase = 0;
  private runningSince: number | null = null;
  private tickHandle = 0;
  private bannerTimer = 0;
  private toastTimer = 0;
  private countdownHandle = 0;
  private expeditePromptedForGame = -1;

  /** 上次使用的選項，與賽事記錄分開保存。 */
  private prefs: store.Prefs = store.loadPrefs();

  private readonly announcer = new Announcer();
  private readonly voice: VoiceScorer;
  private readonly wake = createWakeLock();

  constructor() {
    this.voice = new VoiceScorer({
      getNames: () => this.config.players,
      getVocab: () => this.prefs.vocab,
      onCommand: (cmd, transcript) => this.onVoiceCommand(cmd, transcript),
      onStatus: ({ listening, message }) => {
        this.prefs.stt = listening;
        store.savePrefs(this.prefs);
        this.renderVoiceState();
        if (message) this.toast(message);
      },
    });

    // 播報期間關閉收音，否則播報聲會被自己聽成指令。
    this.announcer.onSpeakingChange = (speaking) => {
      if (speaking) this.voice.pause();
      else this.voice.resume();
    };

    this.announcer.enabled = this.prefs.tts;
    this.announcer.rate = this.prefs.rate;
    this.announcer.setVoice(this.prefs.voiceURI);
    // 語音清單是非同步載入的，載完要重繪下拉選單。
    this.announcer.onVoicesChanged = () => this.renderVoiceOptions();

    this.bindSetup();
    this.bindBoard();
    this.bindSettings();
    this.renderVoiceState();
  }

  // ── 設定畫面 ────────────────────────────────────────────

  private bindSetup(): void {
    bindSegmented('inBestOf');
    bindSegmented('inFirstServer');
    bindSegmented('inStartingEnd');

    const syncNames = () => {
      const a = ($('inNameA') as HTMLInputElement).value.trim() || '選手 A';
      const b = ($('inNameB') as HTMLInputElement).value.trim() || '選手 B';
      const [btnA, btnB] = [...$('inFirstServer').querySelectorAll('button')];
      if (btnA) btnA.textContent = a;
      if (btnB) btnB.textContent = b;
      const legend = $('inStartingEnd').previousElementSibling;
      if (legend) legend.textContent = `第一局 — ${a} 站在`;
    };
    // 以上次使用的選項預填，省去每場重打
    ($('inNameA') as HTMLInputElement).value = this.prefs.players[0];
    ($('inNameB') as HTMLInputElement).value = this.prefs.players[1];
    setSegValue('inBestOf', String(this.prefs.bestOf));
    setSegValue('inFirstServer', String(this.prefs.firstServer));
    setSegValue('inStartingEnd', String(this.prefs.startingEnd));
    syncNames();

    $('btnSettingsSetup').addEventListener('click', () => this.openSettings());

    $('inNameA').addEventListener('input', syncNames);
    $('inNameB').addEventListener('input', syncNames);

    const saved = store.load();
    if (saved && saved.events.length > 0) {
      const btn = $('btnResume');
      btn.hidden = false;
      btn.addEventListener('click', () => {
        this.config = saved.config;
        this.events = saved.events;
        this.redoStack = [];
        this.enterBoard(false);
      });
      $('setupHint').textContent = `偵測到未完成的比賽（${new Date(saved.savedAt).toLocaleString('zh-TW')}）。`;
    }

    $('btnStart').addEventListener('click', () => {
      this.config = {
        players: [
          ($('inNameA') as HTMLInputElement).value.trim() || '選手 A',
          ($('inNameB') as HTMLInputElement).value.trim() || '選手 B',
        ],
        bestOf: Number(segValue('inBestOf')) as BestOf,
        firstServer: Number(segValue('inFirstServer')) as PlayerIndex,
        startingEnd: Number(segValue('inStartingEnd')) as PlayerIndex,
      };
      this.prefs = {
        ...this.prefs,
        players: this.config.players,
        bestOf: this.config.bestOf,
        firstServer: this.config.firstServer,
        startingEnd: this.config.startingEnd,
      };
      store.savePrefs(this.prefs);

      this.events = [];
      this.redoStack = [];
      this.enterBoard(true);
    });
  }

  private enterBoard(announceStart: boolean): void {
    // 必須在使用者手勢中解鎖，否則 iOS 之後都不會發聲。
    this.announcer.unlock();
    this.wake.request();

    $('setup').hidden = true;
    $('board').hidden = false;

    // 全螢幕是兩件事的前提：Android 只有在全螢幕或已安裝的 PWA 才會把畫面
    // 畫進鏡頭挖孔區，否則系統一律補上黑邊；orientation.lock() 也多半要求
    // 全螢幕。這裡仍在「開始比賽」的使用者手勢中，失敗就靜默略過。
    void enterFullscreenAndLock();

    this.state = reduce(this.config, this.events);
    this.expeditePromptedForGame = -1;
    this.resetGameClock();
    this.render();
    this.calibrateScoreCentering();
    this.persist();

    if (this.tickHandle === 0) {
      this.tickHandle = window.setInterval(() => this.tick(), 250);
    }

    if (announceStart) {
      this.announcer.say(
        `比賽開始，${BEST_OF_LABEL[this.config.bestOf]}，${this.config.players[this.state.server]} 發球`,
      );
    }
    if (!this.voice.supported) {
      ($('swStt') as HTMLButtonElement).disabled = true;
      $('sttHint').textContent = '這個瀏覽器不支援語音辨識（Firefox 尚未支援）。';
    } else if (this.prefs.stt) {
      // 沿用上次的選擇；瀏覽器仍會另外詢問麥克風權限。
      this.voice.start();
    }
  }

  // ── 記分畫面 ────────────────────────────────────────────

  private bindBoard(): void {
    this.bindCourt($('courtL'), 'left');
    this.bindCourt($('courtR'), 'right');

    $('btnToL').addEventListener('click', (e) => {
      e.stopPropagation();
      this.requestTimeout('left');
    });
    $('btnToR').addEventListener('click', (e) => {
      e.stopPropagation();
      this.requestTimeout('right');
    });

    $('btnUndo').addEventListener('click', () => this.undo());
    $('btnRedo').addEventListener('click', () => this.redo());
    $('btnSettings').addEventListener('click', () => this.openSettings());
    $('btnEnd').addEventListener('click', () => this.confirmNewMatch());

    $('btnRally').addEventListener('click', () => this.bumpRally());
    $('btnRallyReset').addEventListener('click', () => {
      this.rally = 0;
      this.render();
    });

    window.addEventListener('keydown', (e) => {
      if ($('board').hidden || !$('modal').hidden || !$('settings').hidden) return;
      const map: Record<string, () => void> = {
        ArrowLeft: () => this.addPoint('left'),
        ArrowRight: () => this.addPoint('right'),
        z: () => this.undo(),
        y: () => this.redo(),
        ' ': () => this.bumpRally(),
      };
      const fn = map[e.key] ?? map[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
  }

  // ── 設定面板 ────────────────────────────────────────────

  private bindSettings(): void {
    $('swTts').addEventListener('click', () => {
      this.announcer.enabled = !this.announcer.enabled;
      if (this.announcer.enabled) this.announcer.unlock();
      else this.announcer.cancel();
      this.prefs.tts = this.announcer.enabled;
      store.savePrefs(this.prefs);
      this.renderVoiceState();
    });

    $('swStt').addEventListener('click', () => {
      // 借這一下使用者手勢解鎖 iOS 的語音合成。
      this.announcer.unlock();
      this.voice.toggle();
    });

    $('selVoice').addEventListener('change', () => {
      const uri = ($('selVoice') as HTMLSelectElement).value;
      this.announcer.setVoice(uri);
      this.prefs.voiceURI = this.announcer.voiceURI;
      store.savePrefs(this.prefs);
      this.renderVoiceOptions();
      this.previewAnnouncement();
    });

    $('rngRate').addEventListener('input', () => {
      this.announcer.rate = Number(($('rngRate') as HTMLInputElement).value);
      $('rateVal').textContent = `${this.announcer.rate.toFixed(2)}×`;
    });

    $('rngRate').addEventListener('change', () => {
      this.prefs.rate = this.announcer.rate;
      store.savePrefs(this.prefs);
      this.previewAnnouncement();
    });

    $('btnPreview').addEventListener('click', () => {
      this.announcer.unlock();
      this.previewAnnouncement();
    });

    for (const [key, id] of VOCAB_FIELDS) {
      $(id).addEventListener('change', () => {
        const raw = ($(id) as HTMLInputElement).value;
        const words = parsePhrases(raw);
        // 清空等同於還原該類別的預設值，避免整組指令失效。
        this.prefs.vocab = { ...this.prefs.vocab, [key]: words.length > 0 ? words : [...DEFAULT_VOCAB[key]] };
        store.savePrefs(this.prefs);
        this.renderVocabFields();
      });
    }

    $('btnVocabReset').addEventListener('click', () => {
      this.prefs.vocab = { ...DEFAULT_VOCAB };
      store.savePrefs(this.prefs);
      this.renderVocabFields();
      this.toast('已還原預設指令');
    });

    $('setFullscreen').addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        }
        const locked = await lockLandscape();
        this.closeSettings();
        if (!locked) this.toast('這個瀏覽器不支援鎖定方向，請手動轉為橫向');
      } catch {
        this.toast('無法進入全螢幕，請手動轉為橫向');
      }
    });

    $('setExpedite').addEventListener('click', () => {
      this.closeSettings();
      this.openExpediteDialog(false);
    });

    $('setNew').addEventListener('click', () => {
      this.closeSettings();
      this.confirmNewMatch();
    });

    $('setClose').addEventListener('click', () => this.closeSettings());

    // 點背景關閉，符合一般對話框的預期
    $('settings').addEventListener('click', (e) => {
      if (e.target === $('settings')) this.closeSettings();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('settings').hidden) this.closeSettings();
    });
  }

  private openSettings(): void {
    // 首頁也能開設定，但比賽相關的項目此時無意義，一律隱藏。
    const inMatch = !$('board').hidden;
    $('matchActions').hidden = !inMatch;
    $('setExpedite').hidden = !inMatch;
    $('setNew').hidden = !inMatch;
    $('setMeta').hidden = !inMatch;
    if (inMatch) this.renderSettings();

    this.renderVoiceState();
    this.renderVoiceOptions();
    this.renderVocabFields();
    ($('rngRate') as HTMLInputElement).value = String(this.announcer.rate);
    $('rateVal').textContent = `${this.announcer.rate.toFixed(2)}×`;
    $('settings').hidden = false;
  }

  /**
   * 數字的墨跡在字框裡天生偏下 —— 字型的 ascender 比 descender 高，
   * 而數字沒有下伸部，所以下方永遠空一截。這裡用 canvas 量出該字型的
   * 實際 metrics，換算成 em 寫進 --score-nudge，讓比分在球權外框裡真正置中。
   * 字型換了（例如裝置沒有 Inter 而回退到系統中文字體）也會自動修正。
   */
  private calibrateScoreCentering(): void {
    const el = $('scoreL');
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!size) return;

    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText('0');

    const fontAsc = m.fontBoundingBoxAscent;
    const fontDesc = m.fontBoundingBoxDescent;
    const inkAsc = m.actualBoundingBoxAscent;
    const inkDesc = m.actualBoundingBoxDescent;
    if (![fontAsc, fontDesc, inkAsc, inkDesc].every((v) => typeof v === 'number' && isFinite(v))) {
      return;
    }

    // 墨跡中心相對於字框中心的偏移量（正值代表偏下）。
    const offset = (fontAsc - fontDesc - (inkAsc - inkDesc)) / 2;
    document.documentElement.style.setProperty('--score-nudge', `${offset / size}em`);
  }

  /** 面板開著時每次比分變動都要同步，因為復原／重做現在也在裡面。 */
  private renderSettings(): void {
    const s = this.state;
    $('setMeta').textContent =
      `${BEST_OF_LABEL[this.config.bestOf]} · ${this.config.players[0]} vs ${this.config.players[1]}` +
      ` · 第 ${s.gameIndex + 1} 局 · 局數 ${s.gamesWon[0]} : ${s.gamesWon[1]}`;
    ($('setExpedite') as HTMLButtonElement).disabled = !expediteAllowed(s);
    ($('btnUndo') as HTMLButtonElement).disabled = this.events.length === 0;
    ($('btnRedo') as HTMLButtonElement).disabled = this.redoStack.length === 0;
  }

  private closeSettings(): void {
    $('settings').hidden = true;
  }

  /** 播報／辨識的狀態同時反映在頂列指示燈與設定面板的開關上。 */
  private renderVoiceState(): void {
    const tts = this.announcer.enabled;
    const stt = this.voice.listening;

    $('swTts').setAttribute('aria-checked', String(tts));
    $('swStt').setAttribute('aria-checked', String(stt));

    $('statusTts').classList.toggle('on', tts);
    $('statusStt').classList.toggle('on', stt);
    $('statusStt').classList.toggle('listening', stt);
  }

  /** 播報聲音的下拉選單：中文語音排前面，其餘歸到「其他語言」。 */
  private renderVoiceOptions(): void {
    const sel = $('selVoice') as HTMLSelectElement;
    const voices = this.announcer.listVoices();

    if (!this.announcer.supported || voices.length === 0) {
      sel.replaceChildren(new Option('這個裝置沒有可用的語音', ''));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;

    const auto = this.announcer.resolvedVoiceName;
    const options: (HTMLOptionElement | HTMLOptGroupElement)[] = [
      new Option(auto ? `自動選擇（${auto}）` : '自動選擇', ''),
    ];

    const groups: [string, SpeechSynthesisVoice[]][] = [
      ['中文語音', voices.filter((v) => v.lang.toLowerCase().startsWith('zh'))],
      ['其他語言', voices.filter((v) => !v.lang.toLowerCase().startsWith('zh'))],
    ];

    for (const [label, list] of groups) {
      if (list.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const v of list) group.append(new Option(`${v.name}（${v.lang}）`, v.voiceURI));
      options.push(group);
    }

    sel.replaceChildren(...options);
    sel.value = this.announcer.voiceURI ?? '';
  }

  private renderVocabFields(): void {
    for (const [key, id] of VOCAB_FIELDS) {
      ($(id) as HTMLInputElement).value = formatPhrases(this.prefs.vocab[key]);
    }
  }

  private previewAnnouncement(): void {
    const names = this.config.players;
    this.announcer.say(`8 比 5，${names[0]} 發球，局點`, { interrupt: true });
  }

  /**
   * 單擊 = 該側加 1 分；雙擊 = 該側減 1 分（僅限本局，不會回溯到上一局）。
   *
   * 第一下會立刻加分以保留即時回饋，因此雙擊時要收回那一分再多扣一分，
   * 淨效果才是使用者預期的「減 1 分」。
   */
  private bindCourt(el: HTMLElement, side: Side): void {
    let lastTapAt = 0;
    // 雙擊第一下之前的事件串：取消扣分時要還原到「整個雙擊手勢之前」。
    let beforeGesture: MatchEvent[] = [];

    const isButton = (t: EventTarget | null) => t instanceof HTMLElement && t.closest('button');

    el.addEventListener('pointerup', (e) => {
      if (isButton(e.target)) return;

      const now = Date.now();
      if (now - lastTapAt <= DOUBLE_TAP_MS) {
        lastTapAt = 0;
        this.removePoint(side, 2, beforeGesture);
        return;
      }
      lastTapAt = now;
      beforeGesture = [...this.events];
      this.addPoint(side);
    });

    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ── 事件寫入 ────────────────────────────────────────────

  private commit(event: MatchEvent): void {
    if (this.state.matchOver) return;
    this.events.push(event);
    this.redoStack = [];
    this.apply();
  }

  private apply(): void {
    const prev = this.state;
    this.state = reduce(this.config, this.events);
    this.rally = 0;

    if (this.state.gameIndex !== prev.gameIndex) this.resetGameClock();

    this.persist();
    this.render();
    this.announceTransition(prev, this.state);
  }

  private persist(): void {
    store.save(this.config, this.events);
  }

  private addPoint(side: Side): void {
    const player = side === 'left' ? this.state.leftPlayer : other(this.state.leftPlayer);
    this.addPointTo(player, 'tap');
  }

  private addPointTo(player: PlayerIndex, source: PointSource): void {
    if (this.state.matchOver) return;
    this.commit({ type: 'POINT', player, source });
  }

  /**
   * 移除本局中該選手最後 count 次得分，用於修正誤觸。
   * 雙擊會傳 2：一分是雙擊自己第一下加上去的，另一分才是真正要扣的。
   */
  private removePoint(side: Side, count = 1, restoreTo?: readonly MatchEvent[]): void {
    const player = side === 'left' ? this.state.leftPlayer : other(this.state.leftPlayer);
    const start = this.indexOfCurrentGameStart();
    const snapshot = [...(restoreTo ?? this.events)];
    let removed = 0;

    for (let i = this.events.length - 1; i >= start && removed < count; i--) {
      const ev = this.events[i];
      if (ev && ev.type === 'POINT' && ev.player === player) {
        this.events.splice(i, 1);
        removed++;
      }
    }

    if (removed === 0) {
      this.toast('本局沒有可扣除的分數');
      return;
    }

    this.redoStack = [];
    this.announcer.cancel();
    this.apply();

    // 快速連續得分有機會被誤判成雙擊，所以留一個一鍵還原的出口。
    this.toast(`${this.config.players[player]} −${count === 2 ? 1 : removed} 分`, {
      label: '取消扣分',
      onClick: () => {
        this.events = snapshot;
        this.redoStack = [];
        this.apply();
      },
    });
  }

  /** 找出目前這一局的第一個事件位置，讓扣分不會影響到已完成的局。 */
  private indexOfCurrentGameStart(): number {
    let completed = 0;
    let points: [number, number] = [0, 0];
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev?.type !== 'POINT') continue;
      points[ev.player]++;
      if (isGameOver(points)) {
        completed = i + 1;
        points = [0, 0];
      }
    }
    return completed;
  }

  private undo(): void {
    const ev = this.events.pop();
    if (!ev) return;
    this.redoStack.push(ev);
    this.announcer.cancel();
    this.apply();
  }

  private redo(): void {
    const ev = this.redoStack.pop();
    if (!ev) return;
    this.events.push(ev);
    this.apply();
  }

  // ── 暫停（3.4.4.2） ─────────────────────────────────────

  private requestTimeout(side: Side): void {
    const player = side === 'left' ? this.state.leftPlayer : other(this.state.leftPlayer);
    if (!canRequestTimeout(this.state, player)) return;

    this.commit({ type: 'TIMEOUT', player });
    this.pauseGameClock();
    this.announcer.say(`${this.config.players[player]} 請求暫停`);

    this.showCountdown('暫停', `${this.config.players[player]} 的 1 分鐘暫停`, TIMEOUT_MS, () => {
      this.resumeGameClock();
      this.announcer.say('暫停結束');
    });
  }

  // ── 輪換發球法（2.15） ──────────────────────────────────

  private openExpediteDialog(auto: boolean): void {
    if (!expediteAllowed(this.state)) {
      this.toast(
        this.state.expedite ? '輪換發球法已在進行中' : '本局合計已達 18 分，依 2.15.2 不得啟動',
      );
      return;
    }

    const title = auto ? '本局已進行滿 10 分鐘' : '啟動輪換發球法';
    const body = auto
      ? '依 2.15.1，本局已達 10 分鐘且合計未滿 18 分。啟動後每人輪發 1 分，接發方回擊滿 13 板即得分，並延續到本場結束。請選擇時間到的當下球是否仍在比賽中（2.15.3）。'
      : '雙方同意即可隨時啟動。啟動後每人輪發 1 分，接發方回擊滿 13 板即得分，並延續到本場結束。請選擇當下球是否仍在比賽中（2.15.3）。';

    this.showModal(title, body, [
      {
        label: '球仍在比賽中 — 原發球者續發',
        accent: true,
        onClick: () => this.startExpedite(true),
      },
      {
        label: '球不在比賽中 — 改由上一分接球者發球',
        onClick: () => this.startExpedite(false),
      },
      { label: '暫不啟動', onClick: () => this.closeModal() },
    ]);
  }

  private startExpedite(ballInPlay: boolean): void {
    this.closeModal();
    this.commit({ type: 'EXPEDITE_ON', ballInPlay });
    this.banner('輪換發球法啟動');
    this.announcer.say(
      `啟動輪換發球法，${this.config.players[this.state.server]} 發球`,
      { interrupt: true },
    );
  }

  private bumpRally(): void {
    if (!this.state.expedite || this.state.matchOver) return;
    this.rally++;
    if (this.rally >= EXPEDITE_RETURN_LIMIT) {
      const receiver = this.state.receiver;
      this.rally = 0;
      this.banner('接發方回擊滿 13 板 — 接發方得分');
      this.addPointTo(receiver, 'tap');
      return;
    }
    this.render();
  }

  // ── 語音指令 ────────────────────────────────────────────

  private onVoiceCommand(cmd: VoiceCommand, transcript: string): void {
    if (this.state.matchOver) return;

    switch (cmd.kind) {
      case 'undo':
        this.undo();
        this.toast(`語音：撤銷（聽到「${transcript}」）`);
        return;
      case 'timeout':
        this.requestTimeout(cmd.side);
        return;
      case 'point': {
        const player = cmd.side === 'left' ? this.state.leftPlayer : other(this.state.leftPlayer);
        this.voicePoint(player, transcript);
        return;
      }
      case 'pointByPlayer':
        this.voicePoint(cmd.player, transcript);
        return;
    }
  }

  private voicePoint(player: PlayerIndex, transcript: string): void {
    this.addPointTo(player, 'voice');
    this.toast(`語音計分：${this.config.players[player]} +1（聽到「${transcript}」）`, {
      label: '撤銷',
      onClick: () => this.undo(),
    });
  }

  // ── 畫面更新 ────────────────────────────────────────────

  private render(): void {
    const s = this.state;
    const left = s.leftPlayer;
    const right = other(left);

    // 賽制不再寫成文字，改由中央面板的圓點總數表達。
    $('gameLabel').textContent = `第 ${s.gameIndex + 1} 局`;

    // 「每 2 分換發」是常態，不值得常駐佔版面；只有 deuce 與輪換發球法
    // 這兩個例外狀態才亮出徽章。徽章不寫原因：10:10 比分本身就看得到，
    // 輪換發球法則有底部常駐的 13 板計數列，寫上去只會把面板撐寬到壓住選手名。
    $('modeChip').hidden = !(s.expedite || s.isDeuce);

    // 局數集中在中央面板，顏色跟著左右兩側目前是哪位選手走。
    const gc = document.querySelector<HTMLElement>('.games-center');
    if (gc) {
      gc.style.setProperty('--gc-left', left === 0 ? 'var(--p1)' : 'var(--p2)');
      gc.style.setProperty('--gc-right', right === 0 ? 'var(--p1)' : 'var(--p2)');
    }
    $('gamesNumL').textContent = String(s.gamesWon[left]);
    $('gamesNumR').textContent = String(s.gamesWon[right]);
    renderPips($('pipsL'), s.gamesWon[left], s.gamesNeeded);
    renderPips($('pipsR'), s.gamesWon[right], s.gamesNeeded);

    this.paintCourt('L', left);
    this.paintCourt('R', right);

    $('rallyPanel').hidden = !s.expedite;
    $('rallyCount').textContent = String(this.rally);

    if (!$('settings').hidden) this.renderSettings();
  }

  private paintCourt(suffix: 'L' | 'R', player: PlayerIndex): void {
    const s = this.state;
    const court = $(`court${suffix}`);
    court.style.setProperty('--player', player === 0 ? 'var(--p1)' : 'var(--p2)');

    const score = $(`score${suffix}`);
    if (score.textContent !== String(s.points[player])) {
      court.classList.add('bumped');
      window.setTimeout(() => court.classList.remove('bumped'), 130);
    }
    score.textContent = String(s.points[player]);

    // 球權指示：發球方的分數區加上外框與呼吸燈。
    court.classList.toggle('serving', !s.matchOver && s.server === player);
    court.classList.toggle('game-point', s.gamePointFor === player && s.matchPointFor !== player);
    court.classList.toggle('match-point', s.matchPointFor === player);

    const btn = $(`btnTo${suffix}`) as HTMLButtonElement;
    btn.disabled = !canRequestTimeout(s, player);
    btn.textContent = s.timeoutsUsed[player] ? '暫停已用' : '暫停';
  }

  // ── 播報 ────────────────────────────────────────────────

  private announceTransition(prev: MatchState, next: MatchState): void {
    if (next.matchOver && !prev.matchOver) {
      const w = next.winner as PlayerIndex;
      const text = `${this.config.players[w]} 獲勝，局數 ${next.gamesWon[w]} 比 ${next.gamesWon[other(w)]}`;
      this.banner(text, 8000);
      this.announcer.say(text, { interrupt: true });
      this.showMatchOver(text);
      this.wake.release();
      return;
    }

    if (next.completedGames.length > prev.completedGames.length) {
      const g = next.completedGames[next.completedGames.length - 1];
      if (!g) return;
      const w = g.winner;
      const parts = [
        `${this.config.players[w]} 以 ${g.points[w]} 比 ${g.points[other(w)]} 拿下第 ${next.completedGames.length} 局`,
        `局數 ${next.gamesWon[0]} 比 ${next.gamesWon[1]}`,
        '交換方位',
        `第 ${next.gameIndex + 1} 局，${this.config.players[next.server]} 發球`,
      ];
      this.banner('交換方位 · 局間休息 1 分鐘', GAME_BREAK_MS);
      this.announcer.say(parts.join('，'), { interrupt: true });
      return;
    }

    const total = next.points[0] + next.points[1];
    if (total === 0 || total === prev.points[0] + prev.points[1]) return;

    // 裁判報分習慣：先報發球方的分數。
    const parts = [`${next.points[next.server]} 比 ${next.points[next.receiver]}`];
    if (next.server !== prev.server) parts.push(`${this.config.players[next.server]} 發球`);
    if (next.matchPointFor !== null) parts.push('賽末點');
    else if (next.gamePointFor !== null) parts.push('局點');

    if (next.endsSwitchedInDecider && !prev.endsSwitchedInDecider) {
      parts.push('交換方位');
      this.banner('決勝局 5 分 — 交換方位', 6000);
    } else if (next.towelBreakDue) {
      this.banner('擦汗間歇', 4000);
    }

    this.announcer.say(parts.join('，'), { interrupt: true });
  }

  // ── 計時 ────────────────────────────────────────────────

  private resetGameClock(): void {
    this.elapsedBase = 0;
    this.runningSince = Date.now();
    this.expeditePromptedForGame = -1;
  }

  private pauseGameClock(): void {
    if (this.runningSince === null) return;
    this.elapsedBase += Date.now() - this.runningSince;
    this.runningSince = null;
  }

  private resumeGameClock(): void {
    if (this.runningSince === null) this.runningSince = Date.now();
  }

  private gameElapsed(): number {
    return this.elapsedBase + (this.runningSince === null ? 0 : Date.now() - this.runningSince);
  }

  private tick(): void {
    if ($('board').hidden) return;
    const ms = this.gameElapsed();
    $('timerLabel').textContent = formatClock(ms);

    if (
      this.expeditePromptedForGame !== this.state.gameIndex &&
      expediteDue(this.state, ms) &&
      $('modal').hidden
    ) {
      this.expeditePromptedForGame = this.state.gameIndex;
      this.openExpediteDialog(true);
    }
  }

  // ── 橫幅、提示、對話框 ──────────────────────────────────

  private banner(text: string, ms = 5000): void {
    const el = $('banner');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  private toast(text: string, action?: { label: string; onClick: () => void }): void {
    const el = $('toast');
    el.replaceChildren(document.createTextNode(text));
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.hidden = true;
        action.onClick();
      });
      el.append(btn);
    }
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, action ? 5000 : 3000);
  }

  private showModal(title: string, body: string, actions: ModalAction[]): void {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body;
    const box = $('modalActions');
    box.replaceChildren(
      ...actions.map((a) => {
        const btn = document.createElement('button');
        btn.textContent = a.label;
        if (a.accent) btn.className = 'accent';
        btn.addEventListener('click', a.onClick);
        return btn;
      }),
    );
    $('modal').hidden = false;
  }

  private closeModal(): void {
    $('modal').hidden = true;
    clearInterval(this.countdownHandle);
    this.countdownHandle = 0;
  }

  private showCountdown(title: string, body: string, ms: number, onDone: () => void): void {
    const endAt = Date.now() + ms;
    const finish = () => {
      this.closeModal();
      onDone();
    };

    const render = () => {
      const left = Math.max(0, endAt - Date.now());
      $('modalTitle').textContent = `${title} — ${Math.ceil(left / 1000)} 秒`;
      if (left <= 0) finish();
    };

    this.showModal(title, body, [{ label: '提前結束', accent: true, onClick: finish }]);
    render();
    this.countdownHandle = window.setInterval(render, 250);
  }

  private showMatchOver(text: string): void {
    this.showModal('比賽結束', text, [
      {
        label: '新比賽',
        accent: true,
        onClick: () => {
          this.closeModal();
          this.newMatch();
        },
      },
      { label: '留在記分板', onClick: () => this.closeModal() },
    ]);
  }

  private confirmNewMatch(): void {
    this.showModal('結束目前比賽？', '這場比賽的所有記錄會被清除，且無法復原。', [
      {
        label: '確定，結束並重新開始',
        accent: true,
        onClick: () => {
          this.closeModal();
          this.newMatch();
        },
      },
      { label: '取消', onClick: () => this.closeModal() },
    ]);
  }

  private newMatch(): void {
    this.announcer.cancel();
    this.voice.stop();
    // store.clear() 只清賽事記錄，prefs 另存一把 key，設定不會被洗掉。
    this.wake.release();
    store.clear();
    this.events = [];
    this.redoStack = [];
    this.state = reduce(this.config, []);
    $('board').hidden = true;
    $('setup').hidden = false;
    $('btnResume').hidden = true;
    $('setupHint').textContent = '';
  }
}

// ── 小工具 ────────────────────────────────────────────────

function bindSegmented(id: string): void {
  const group = $(id);
  group.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || !group.contains(btn)) return;
    for (const b of group.querySelectorAll('button')) b.classList.remove('on');
    btn.classList.add('on');
  });
}

/**
 * 盡力鎖定橫向。
 *
 * lock() 在多數瀏覽器要求先進入全螢幕，iOS Safari 則完全不支援，
 * 因此失敗是常態 —— 回傳成功與否讓呼叫端決定要不要提示使用者。
 */
/**
 * 進入全螢幕並鎖定橫向。
 *
 * 只在觸控裝置自動全螢幕 —— 桌機用一般視窗看板面是正常用法，不該因為按下
 * 「開始比賽」就被搶進全螢幕。被擋下不影響計分，設定裡仍有手動入口。
 */
async function enterFullscreenAndLock(): Promise<void> {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  try {
    if (touch && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    /* 使用者手勢過期或瀏覽器政策擋下都屬正常，靜默略過。 */
  }
  await lockLandscape();
}

async function lockLandscape(): Promise<boolean> {
  const orientation = screen.orientation as
    | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
    | undefined;
  if (!orientation?.lock) return false;
  try {
    await orientation.lock('landscape');
    return true;
  } catch {
    return false;
  }
}

/** 圓點總數＝取勝所需局數，實心＝已贏局數。 */
function renderPips(host: HTMLElement, won: number, needed: number): void {
  host.replaceChildren(
    ...Array.from({ length: needed }, (_, i) => {
      const dot = document.createElement('span');
      dot.className = i < won ? 'pip won' : 'pip';
      return dot;
    }),
  );
}

function setSegValue(id: string, value: string): void {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.getAttribute('data-value') === value);
  }
}

function segValue(id: string): string {
  return $(id).querySelector('button.on')?.getAttribute('data-value') ?? '0';
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
