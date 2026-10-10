// ===== Config.gs =====
// 実際の値はスクリプトエディタの「プロジェクトの設定」→「スクリプト プロパティ」で設定してください。
//   CONTROL_SHEET_ID          : 親（コントロール）シートのスプレッドシートID
//   LINE_CHANNEL_ACCESS_TOKEN : LINE Developersで発行したチャネルアクセストークン

const CONFIG = {
  CONTROL_SHEET_ID: PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID'),
  LINE_CHANNEL_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
};

// 親シート・開催別シートで使うタブ名
const SHEET_NAMES = {
  EVENT_MASTER: '開催マスタ',
  NOTIFY_LIST: '主催者通知先',
  TEMPLATE_LIST: 'ひな形',          // 親シート：開催シートのひな形一覧（ひな形名 / URL）
  STAFF_LIST: '対応者一覧',
  SLOT_MASTER: '枠マスタ',
  MENU_LIST: ['メニュー', '施術メニュー'], // 先に見つかった方を使う（旧ひな形との互換）
  RESERVATIONS: '予約',
  SETTINGS: '設定',
  DAY_SCHEDULE: '当日スケジュール',
  PENDING_LIST: '要確認リスト',
};

// 予約タブの列位置（見出しの文字ではなく位置で読むので、見出しは自由に変えられる）
const RES_COL = {
  id: 1, slot: 2, organizer: 3, guest: 4, age: 5, gender: 6, staff: 7, menu: 8, note: 9,
  createdAt: 10, status: 11, confirmedStaff: 12, confirmedSlot: 13, memo: 14,
  slotLabel: 15, dup: 16,
};
const RES_DATA_COLS = 14; // 値を読み書きする列数（O・P列は数式）

const STATUS = { ACCEPTED: '受付', PENDING: '要確認', CANCELED: 'キャンセル', CHANGED: '変更済' };

// 設定タブが無い・空欄のときに使う初期値（美容イベント版）
// enabled を false にできる項目: organizer / age / gender / staff / menu / note
// （guest と slot は必須なので常にON）
const DEFAULT_SETTINGS = {
  organizer: { label: '動員する人', question: 'あなた（動員する人）のお名前を教えてください。', enabled: true, choices: [] },
  guest: { label: 'ゲスト名', question: 'ゲストのお名前を教えてください。', enabled: true, choices: [] },
  slot: { label: '時間枠', question: 'ご希望の時間枠を選んでください。', enabled: true, choices: [] },
  age: { label: '年齢(おおよそ)', question: 'ゲストの年齢（おおよそ）を教えてください。', enabled: true,
    choices: ['10代', '20代', '30代', '40代', '50代以上'] },
  gender: { label: '性別', question: '性別を教えてください。', enabled: true, choices: ['女性', '男性', '回答しない'] },
  // staff の choices は「対応者一覧の後ろに付ける選択肢」（例：誰でも良い）
  staff: { label: '希望する対応者', question: '希望する対応者はいますか？', enabled: true, choices: ['誰でも良い'] },
  menu: { label: '希望する施術', question: 'やって欲しい施術を選んでください（複数選択できます）。', enabled: true, choices: [] },
  // note の choices の先頭は「特になし」に当たる言葉（これが選ばれたら空欄として保存）
  note: { label: '伝えておきたいこと', question: '伝えておきたいことがあれば教えてください（アレルギーなど）。', enabled: true,
    choices: ['特になし'] },
  // 当日スケジュールの見出しなどに使う「対応する人」の呼び方
  staff_role: { label: '対応者', enabled: true, choices: [] },
  msg_accepted: { label: '受付完了メッセージ', text: '受け付けました（予約No.{no}）。', enabled: true, choices: [] },
  msg_pending: { label: '要確認メッセージ',
    text: '現在満枠のため「要確認」として登録しました（予約No.{no}）。主催者確認後、あらためてご連絡します。',
    enabled: true, choices: [] },
};

// 会話状態（CacheService）の保持時間。この時間操作がないと最初からやり直しになる
const STATE_CACHE_SECONDS = 1800; // 30分

// LINEのクイックリプライは最大13個
const MAX_QUICK_REPLIES = 13;

// ===== EventAdmin.gs =====
// 親シートのメニューから使う、開催の作成・選択まわりの処理。

const EventAdmin = {
  // 親シート「ひな形」タブ：A=ひな形名 / B=スプレッドシートURL
  getTemplates() {
    const sheet = SheetUtils.getControlSheet().getSheetByName(SHEET_NAMES.TEMPLATE_LIST);
    if (!sheet) return [];
    return sheet.getDataRange().getDisplayValues().slice(1)
      .filter(r => r[0] !== '' && /\/d\/[a-zA-Z0-9-_]+/.test(r[1]))
      .map(r => ({ name: r[0], url: r[1] }));
  },

  // ひな形を複製して「開催年月日_開催名」のファイルを作り、開催マスタに追記する
  createEvent(parsedDate, name, template) {
    const eventId = `${parsedDate.yyyymmdd}_${name}`;
    const control = SheetUtils.getControlSheet();
    const master = control.getSheetByName(SHEET_NAMES.EVENT_MASTER);

    const existing = SheetUtils.getAllEvents().some(e => e.eventId === eventId);
    const idColumn = master.getRange(1, 1, master.getMaxRows(), 1).getValues().flat();
    if (existing || idColumn.indexOf(eventId) !== -1) {
      throw new Error(`開催ID「${eventId}」はすでに開催マスタにあります。`);
    }

    // 親シートと同じフォルダに複製する
    const controlFile = DriveApp.getFileById(CONFIG.CONTROL_SHEET_ID);
    const parents = controlFile.getParents();
    const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    const copy = DriveApp.getFileById(SheetUtils.extractSpreadsheetId(template.url)).makeCopy(eventId, folder);

    // 予約タブの見出しを、ひな形の設定タブの表示名に合わせる
    const newSs = SpreadsheetApp.openById(copy.getId());
    Settings.applyHeaders(newSs, Settings.load(newSs));

    // 開催マスタの「開催IDが空の最初の行」に書き込む（ひな形の空き行を使う）
    const header = master.getRange(1, 1, 1, master.getLastColumn()).getValues()[0];
    const col = n => header.indexOf(n) + 1;
    let row = idColumn.findIndex((v, i) => i >= 1 && v === '') + 1;
    if (row === 0) row = master.getLastRow() + 1;

    master.getRange(row, col('開催ID')).setValue(eventId);
    // 文字列で書き込むと、スプレッドシート側の設定（タイムゾーン）で日付として解釈される
    master.getRange(row, col('開催日')).setValue(parsedDate.display);
    master.getRange(row, col('開催名')).setValue(name);
    master.getRange(row, col('予約シートURL')).setValue(copy.getUrl());
    master.getRange(row, col('ステータス')).setValue('準備中');

    return { eventId: eventId, url: copy.getUrl() };
  },

  // 開催マスタの一覧から、番号入力で1件選ぶ（メニュー用）。キャンセル・該当なしは null
  pickEvent_(title) {
    const ui = SpreadsheetApp.getUi();
    const events = SheetUtils.getAllEvents();
    if (events.length === 0) {
      ui.alert('予約シートのURLが入っている開催が、開催マスタにありません。');
      return null;
    }
    if (events.length === 1) return events[0];

    const list = events.map((e, i) => `${i + 1}. ${e.name}（${e.status || 'ステータス未設定'}）`).join('\n');
    const res = ui.prompt(title, '番号を入力してください。\n\n' + list, ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return null;
    const n = parseInt(Util.toHalfWidth(res.getResponseText()), 10);
    if (!(n >= 1 && n <= events.length)) {
      ui.alert('番号を読み取れませんでした。もう一度やり直してください。');
      return null;
    }
    return events[n - 1];
  },
};

// ===== Main.gs =====
// LINEからのWebhookを受け取る入口。
// Webアプリとしてデプロイし、そのURLをLINE DevelopersのWebhook URLに設定してください。

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];
    events.forEach(handleEvent);
  } catch (err) {
    console.error('doPost error: ' + err + '\n' + (err && err.stack));
  }
  // LINE Platformへは常に200 OKを返す
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleEvent(event) {
  const userId = event.source && event.source.userId;
  if (!userId) return;

  if (event.type === 'message' && event.message.type === 'text') {
    handleTextMessage(userId, event.replyToken, event.message.text.trim());
  }
  // 将来リッチメニューをpostback形式にする場合はここにhandlePostbackを追加
}

function handleTextMessage(userId, replyToken, text) {
  // 会話が止まってしまった場合の緊急リセット用
  if (text === 'リセット') {
    StateManager.clear(userId);
    LineApi.reply(replyToken, '操作をリセットしました。「登録」「キャンセル」「登録確認」「変更」のいずれかを送ってください。');
    return;
  }

  const state = StateManager.get(userId);

  if (!state) {
    // 会話中でない場合は、トリガーワードとして判定する
    const flow = matchTrigger(text);
    if (flow) {
      startFlow(flow, userId, replyToken);
    } else {
      LineApi.reply(replyToken,
        'メニューから「登録」「キャンセル」「登録確認」「変更」のいずれかを送ってください。');
    }
    return;
  }

  // 会話中の場合は、現在のステップの続きとして処理する
  routeToFlow(state, userId, replyToken, text);
}

function matchTrigger(text) {
  if (text === '登録') return 'register';
  if (text === 'キャンセル') return 'cancel';
  if (text === '登録確認') return 'confirm';
  if (text === '変更') return 'change';
  return null;
}

// 募集中の開催が複数あれば、番号で選んでもらってから各フローを始める
function startFlow(flow, userId, replyToken) {
  const events = SheetUtils.getActiveEvents();
  if (events.length === 0) {
    LineApi.reply(replyToken, '現在募集中の開催がありません。主催者にご確認ください。');
    return;
  }
  if (events.length === 1) {
    beginFlow(flow, userId, replyToken, events[0]);
    return;
  }
  EventSelector.ask(flow, userId, replyToken, events);
}

function beginFlow(flow, userId, replyToken, event) {
  switch (flow) {
    case 'register': return RegisterFlow.start(userId, replyToken, event);
    case 'cancel': return CancelFlow.start(userId, replyToken, event);
    case 'confirm': return ConfirmFlow.start(userId, replyToken, event);
    case 'change': return ChangeFlow.start(userId, replyToken, event);
  }
}

function routeToFlow(state, userId, replyToken, text) {
  switch (state.flow) {
    case 'select_event': return EventSelector.handle(state, userId, replyToken, text);
    case 'register': return RegisterFlow.handle(state, userId, replyToken, text);
    case 'cancel': return CancelFlow.handle(state, userId, replyToken, text);
    case 'confirm': return ConfirmFlow.handle(state, userId, replyToken, text);
    case 'change': return ChangeFlow.handle(state, userId, replyToken, text);
    default:
      StateManager.clear(userId);
      LineApi.reply(replyToken, 'エラーが発生しました。もう一度メニューから選び直してください。');
  }
}

// ===== Menu.gs =====
// 親（コントロール）シートを開いた時に、上部メニュー「予約管理」を表示する。
// このコードは親シートのGASプロジェクト（LINEのWebhookと同じプロジェクト）に入れてください。
// 開催別シート側には、もうGASは不要です。

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('予約管理')
    .addItem('新しい開催を作成（ひな形から複製）', 'menu_createEvent')
    .addItem('当日スケジュールと要確認リストを更新', 'menu_buildDaySchedule')
    .addItem('予約タブの見出しを設定に合わせる', 'menu_applyHeaders')
    .addToUi();
}

// ---------- 新しい開催を作成 ----------
function menu_createEvent() {
  const ui = SpreadsheetApp.getUi();

  const templates = EventAdmin.getTemplates();
  if (templates.length === 0) {
    ui.alert('親シートの「ひな形」タブに、ひな形名（A列）とスプレッドシートのURL（B列）を入力してください。');
    return;
  }

  const dateRes = ui.prompt('新しい開催（1/3）', '開催日を入力してください。（例：2026/11/01）', ui.ButtonSet.OK_CANCEL);
  if (dateRes.getSelectedButton() !== ui.Button.OK) return;
  const parsed = Util.parseDate(dateRes.getResponseText());
  if (!parsed) {
    ui.alert('開催日を読み取れませんでした。「2026/11/01」のように入力してください。');
    return;
  }

  const nameRes = ui.prompt('新しい開催（2/3）', '開催名を入力してください。（例：11月表参道Beauty）', ui.ButtonSet.OK_CANCEL);
  if (nameRes.getSelectedButton() !== ui.Button.OK) return;
  const name = nameRes.getResponseText().trim();
  if (!name) {
    ui.alert('開催名が空です。');
    return;
  }

  let template = templates[0];
  if (templates.length > 1) {
    const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
    const tplRes = ui.prompt('新しい開催（3/3）', 'どのひな形を使いますか？番号を入力してください。\n\n' + list, ui.ButtonSet.OK_CANCEL);
    if (tplRes.getSelectedButton() !== ui.Button.OK) return;
    const n = parseInt(Util.toHalfWidth(tplRes.getResponseText()), 10);
    if (!(n >= 1 && n <= templates.length)) {
      ui.alert('番号を読み取れませんでした。最初からやり直してください。');
      return;
    }
    template = templates[n - 1];
  }

  try {
    const result = EventAdmin.createEvent(parsed, name, template);
    ui.alert(
      `開催「${result.eventId}」を作成しました。\n\n` +
      '開催マスタに追加しました（ステータスは「準備中」です）。\n' +
      '次の手順で準備してください。\n' +
      '1. 新しいシートの「設定」「対応者一覧」「枠マスタ」「メニュー」を入力する\n' +
      '2. 準備ができたら、開催マスタのステータスを「募集中」にする');
  } catch (err) {
    ui.alert('作成に失敗しました。\n' + err.message);
  }
}

// ---------- 当日スケジュールと要確認リストを更新 ----------
function menu_buildDaySchedule() {
  const ui = SpreadsheetApp.getUi();
  const event = EventAdmin.pickEvent_('更新する開催を選んでください');
  if (!event) return;

  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  const duplicateCount = SheetUtils.buildDaySchedule(ss);
  const pendingCount = SheetUtils.buildPendingList(ss);

  const lines = [`「${event.name}」を更新しました。`];
  lines.push(duplicateCount > 0
    ? `同じ対応者に複数ゲストが割り当てられているセルが ${duplicateCount} 件あります（オレンジ色のセル）。`
    : '当日スケジュールに重複はありません。');
  lines.push(`要確認の予約：${pendingCount} 件`);
  ui.alert(lines.join('\n'));
}

// ---------- 予約タブの見出しを設定に合わせる ----------
function menu_applyHeaders() {
  const ui = SpreadsheetApp.getUi();
  const event = EventAdmin.pickEvent_('見出しを更新する開催を選んでください');
  if (!event) return;

  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  Settings.applyHeaders(ss, Settings.load(ss));
  ui.alert(`「${event.name}」の予約タブの見出しを、設定タブの表示名に合わせました。`);
}

// ===== Settings.gs =====
// 開催別シートの「設定」タブを読み込む。タブが無い・空欄・「…」だけの項目は、Config.gsの初期値を使う。
//
// 設定タブの列：A=内部キー / B=表示名 / C=LINEの質問文（msg_で始まる行は返信メッセージ）/ D=使う(ON/OFF) / E=選択肢
// 選択肢はカンマ（, 、 ，）区切り。

const Settings = {
  REQUIRED: ['guest', 'slot'], // OFFにできない項目

  load(ss) {
    const st = {};
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      st[key] = Object.assign({}, DEFAULT_SETTINGS[key], { choices: DEFAULT_SETTINGS[key].choices.slice() });
    });

    const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    if (sheet) {
      sheet.getDataRange().getDisplayValues().slice(1).forEach(r => {
        const key = String(r[0]).trim();
        const item = st[key];
        if (!item) return;

        const label = this._text(r[1]);
        if (label) item.label = label;

        const body = this._text(r[2]);
        if (body) {
          if (key.indexOf('msg_') === 0) item.text = body; else item.question = body;
        }

        const onoff = String(r[3]).trim().toUpperCase();
        if (onoff === 'OFF') item.enabled = false;
        if (onoff === 'ON') item.enabled = true;

        const choices = this._choices(r[4]);
        if (choices.length > 0) item.choices = choices;
      });
    }
    this.REQUIRED.forEach(key => { st[key].enabled = true; });
    return st;
  },

  isOn(st, key) {
    return !!st[key] && st[key].enabled !== false;
  },

  // 空欄や、書きかけの「…」で終わる文は「未設定」とみなして初期値に戻す
  _text(value) {
    const v = String(value === null || value === undefined ? '' : value).trim();
    if (v === '' || /…$/.test(v) || /\.\.\.$/.test(v)) return '';
    return v;
  },

  _choices(value) {
    return String(value === null || value === undefined ? '' : value)
      .split(/[,、，\n]/).map(s => s.trim()).filter(s => s !== '');
  },

  // 予約タブの見出しを設定の「表示名」に合わせる（列の位置は変わらない）
  applyHeaders(ss, st) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    if (!sheet) return;
    sheet.getRange(1, 1, 1, 16).setValues([[
      '予約ID', '枠番号', st.organizer.label, st.guest.label, st.age.label, st.gender.label,
      st.staff.label, st.menu.label, st.note.label, '登録日時', 'ステータス',
      '確定' + st.staff_role.label, '確定枠番号', '主催者メモ', '枠表示', '重複チェック',
    ]]);
  },
};

// ===== EventSelector.gs =====
// 募集中の開催が複数あるとき、番号で選んでもらう。
//   「どの開催についてですか？ 1. ○○ 2. △△  番号を選択し、入力してください。」

const EventSelector = {
  MAX: 12, // クイックリプライは13個まで。「やめる」ボタン分を1つ空ける

  ask(flow, userId, replyToken, events) {
    const list = events.slice(0, this.MAX).map(e => ({
      eventId: e.eventId, name: e.name, label: e.label, spreadsheetUrl: e.spreadsheetUrl,
    }));
    StateManager.set(userId, { flow: 'select_event', next: flow, events: list });

    const lines = list.map((e, i) => `${i + 1}. ${e.label}`);
    LineApi.reply(replyToken,
      ['どの開催についてですか？', ...lines, '', '番号を選択し、入力してください。'].join('\n'),
      [...list.map((e, i) => String(i + 1)), 'やめる']);
  },

  handle(state, userId, replyToken, text) {
    if (text === 'やめる') {
      StateManager.clear(userId);
      LineApi.reply(replyToken, '中止しました。');
      return;
    }
    const n = parseInt(Util.toHalfWidth(text), 10);
    if (!(n >= 1 && n <= state.events.length)) {
      LineApi.reply(replyToken, `1〜${state.events.length}の番号で入力してください。`,
        [...state.events.map((e, i) => String(i + 1)), 'やめる']);
      return;
    }
    StateManager.clear(userId);
    beginFlow(state.next, userId, replyToken, state.events[n - 1]);
  },
};

// ===== RegisterFlow.gs =====
// 「登録」フロー。質問の順番は下のORDERのとおりで、設定タブでOFFにした項目は飛ばします。
//   （動員する人[初回のみ名前確認]→）ゲスト名→時間枠→年齢→性別→希望対応者→メニュー(複数可)→伝達事項→確認→保存

const REGISTER_ORDER = ['guest', 'slot', 'age', 'gender', 'staff', 'menu', 'note'];
const MENU_DONE = '選び終わった';

const RegisterFlow = {
  start(userId, replyToken, event) {
    const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
    const st = Settings.load(ss);
    const state = {
      flow: 'register',
      step: null,
      spreadsheetUrl: event.spreadsheetUrl,
      eventName: event.name,
      data: {},
    };
    const head = `「${event.name}」のご登録ですね。\n`;

    // 「動員する人」をOFFにしている開催（個別相談会など）は、ゲスト名から聞き始める
    if (!Settings.isOn(st, 'organizer')) {
      this._next(state, userId, replyToken, ss, st, null, head);
      return;
    }

    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken,
        `${head}前回「${lastName}」として登録されていますが、今回も同じ名前でよいですか？`,
        ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      state.step = 'ASK_ORGANIZER_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, head + st.organizer.question);
    }
  },

  handle(state, userId, replyToken, text) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const st = Settings.load(ss);
    const d = state.data;

    switch (state.step) {
      case 'CONFIRM_ORGANIZER_NAME':
        if (text === 'はい') {
          d.organizerName = d.organizerNameCandidate;
          this._next(state, userId, replyToken, ss, st, null, '');
        } else {
          state.step = 'ASK_ORGANIZER_NAME';
          StateManager.set(userId, state);
          LineApi.reply(replyToken, 'お名前を入力してください。');
        }
        return;

      case 'ASK_ORGANIZER_NAME':
        d.organizerName = text;
        StateManager.setLastOrganizerName(userId, text);
        this._next(state, userId, replyToken, ss, st, null, '');
        return;

      case 'ASK_GUEST':
        d.guestName = text;
        // 「動員する人」をOFFにしている開催では、動員する人＝ゲスト本人として扱う
        if (!Settings.isOn(st, 'organizer')) d.organizerName = text;
        this._next(state, userId, replyToken, ss, st, 'guest', '');
        return;

      case 'ASK_SLOT': {
        const slots = SheetUtils.getSlotList(ss);
        const slot = slots.find(s => SheetUtils.slotLabel(s) === text);
        if (!slot) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', slots.map(s => SheetUtils.slotLabel(s)));
          return;
        }
        d.slotNumber = slot['枠番号'];
        d.slotText = SheetUtils.slotLabel(slot);
        this._next(state, userId, replyToken, ss, st, 'slot', '');
        return;
      }

      case 'ASK_AGE':
        d.age = text;
        this._next(state, userId, replyToken, ss, st, 'age', '');
        return;

      case 'ASK_GENDER':
        d.gender = text;
        this._next(state, userId, replyToken, ss, st, 'gender', '');
        return;

      case 'ASK_STAFF': {
        const options = [...SheetUtils.getStaffList(ss), ...st.staff.choices];
        if (!options.includes(text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', options);
          return;
        }
        d.staff = text;
        this._next(state, userId, replyToken, ss, st, 'staff', '');
        return;
      }

      case 'ASK_MENU':
        this._handleMenuSelection(state, userId, replyToken, text,
          () => this._next(state, userId, replyToken, ss, st, 'menu', ''));
        return;

      case 'ASK_NOTE': {
        const none = st.note.choices[0] || '特になし';
        d.note = (text === none) ? '' : text;
        this._next(state, userId, replyToken, ss, st, 'note', '');
        return;
      }

      case 'CONFIRM':
        if (text === 'この内容で登録') {
          this._save(state, userId, replyToken, ss, st);
        } else {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '登録を中止しました。最初からやり直す場合は「登録」と送ってください。');
        }
        return;

      default:
        StateManager.clear(userId);
        LineApi.reply(replyToken, 'エラーが発生しました。もう一度「登録」と送ってください。');
    }
  },

  // afterKey の次に聞く項目（ONになっているもの）へ進む。全部終われば確認画面
  _next(state, userId, replyToken, ss, st, afterKey, prefix) {
    let i = afterKey ? REGISTER_ORDER.indexOf(afterKey) + 1 : 0;
    for (; i < REGISTER_ORDER.length; i++) {
      const key = REGISTER_ORDER[i];
      if (!Settings.isOn(st, key)) continue;
      if (this._ask(state, userId, replyToken, ss, st, key, prefix)) return;
    }
    state.step = 'CONFIRM';
    StateManager.set(userId, state);
    LineApi.reply(replyToken, prefix + this._buildConfirmText(state, st), ['この内容で登録', 'やり直す']);
  },

  // 1項目ぶんの質問を送る。選択肢が1つも無くて飛ばした場合は false を返す
  _ask(state, userId, replyToken, ss, st, key, prefix) {
    const question = prefix + st[key].question;

    switch (key) {
      case 'guest':
        state.step = 'ASK_GUEST';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question);
        return true;

      case 'slot': {
        const slots = SheetUtils.getSlotList(ss);
        if (slots.length === 0) {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '現在選べる時間枠がありません。主催者にご確認ください。');
          return true;
        }
        state.step = 'ASK_SLOT';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, slots.map(s => SheetUtils.slotLabel(s)));
        return true;
      }

      case 'age':
      case 'gender':
        state.step = key === 'age' ? 'ASK_AGE' : 'ASK_GENDER';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, st[key].choices);
        return true;

      case 'staff': {
        const staffList = SheetUtils.getStaffList(ss);
        if (staffList.length === 0) return false;
        state.step = 'ASK_STAFF';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, [...staffList, ...st.staff.choices]);
        return true;
      }

      case 'menu': {
        const menu = SheetUtils.getMenuList(ss);
        if (menu.length === 0) return false;
        state.data.treatments = [];
        // クイックリプライは13個までなので、「選び終わった」を入れて最大12項目
        state.data.remainingTreatments = menu.slice(0, MAX_QUICK_REPLIES - 1);
        state.step = 'ASK_MENU';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, [...state.data.remainingTreatments, MENU_DONE]);
        return true;
      }

      case 'note':
        state.step = 'ASK_NOTE';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, st.note.choices);
        return true;
    }
    return false;
  },

  // メニューの複数選択（登録・変更フロー共通で使う）。選び終わったら onDone を呼ぶ
  _handleMenuSelection(state, userId, replyToken, text, onDone) {
    const d = state.data;
    if (text === MENU_DONE) {
      if (d.treatments.length === 0) {
        LineApi.reply(replyToken, '1つ以上選んでください。', [...d.remainingTreatments, MENU_DONE]);
        return;
      }
      onDone();
      return;
    }
    if (!d.remainingTreatments.includes(text)) {
      LineApi.reply(replyToken, '選択肢の中から選んでください。', [...d.remainingTreatments, MENU_DONE]);
      return;
    }
    d.treatments.push(text);
    d.remainingTreatments = d.remainingTreatments.filter(t => t !== text);
    StateManager.set(userId, state);
    LineApi.reply(replyToken, `「${text}」を選びました。他にもありますか？`,
      [...d.remainingTreatments, MENU_DONE]);
  },

  _buildConfirmText(state, st) {
    const d = state.data;
    const lines = [
      `「${state.eventName}」に以下の内容で登録します。よろしいですか？`,
      `${st.guest.label}：${d.guestName}`,
      `${st.slot.label}：${d.slotText}`,
    ];
    if (Settings.isOn(st, 'age') && d.age !== undefined) lines.push(`${st.age.label}：${d.age}`);
    if (Settings.isOn(st, 'gender') && d.gender !== undefined) lines.push(`${st.gender.label}：${d.gender}`);
    if (d.staff !== undefined) lines.push(`${st.staff.label}：${d.staff}`);
    if (d.treatments) lines.push(`${st.menu.label}：${d.treatments.join('、')}`);
    if (Settings.isOn(st, 'note')) lines.push(`${st.note.label}：${d.note || 'なし'}`);
    return lines.join('\n');
  },

  _save(state, userId, replyToken, ss, st) {
    const d = state.data;
    const result = SheetUtils.appendReservation(ss, d);
    StateManager.clear(userId);

    const template = (result.status === STATUS.ACCEPTED) ? st.msg_accepted.text : st.msg_pending.text;
    LineApi.reply(replyToken, Util.fillTemplate(template, { no: result.reservationId }));

    const who = (d.organizerName && d.organizerName !== d.guestName)
      ? `${d.organizerName}さんが${d.guestName}さんを` : `${d.guestName}さんが`;
    SheetUtils.notifyOrganizers(
      `【新規登録】[${state.eventName}] ${who}登録しました（${d.slotText} / ステータス:${result.status}）`
    );
  },
};

// ===== ChangeFlow.gs =====
// 「変更」フロー：希望対応者・メニュー・年齢・性別・伝達事項（設定でONの項目）だけ変更できる。
// ゲスト名・時間枠を変えたい場合は、キャンセル→登録し直しの運用とする（合意済み）。

const CHANGEABLE_KEYS = ['staff', 'menu', 'age', 'gender', 'note'];

const ChangeFlow = {
  start(userId, replyToken, event) {
    const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
    const st = Settings.load(ss);
    const state = {
      flow: 'change', step: null,
      spreadsheetUrl: event.spreadsheetUrl, eventName: event.name, data: {},
    };
    Identity.begin(state, userId, replyToken, st, {
      head: `「${event.name}」の変更ですね。\n`,
      confirmText: name => `「${name}」さんの予約から探しますか？`,
      askSelf: 'ご予約時のお名前を教えてください。',
    });
  },

  handle(state, userId, replyToken, text) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const st = Settings.load(ss);

    if (Identity.isOrganizerStep(state)) {
      if (Identity.handleOrganizerStep(state, userId, replyToken, text)) {
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `変更する「${st.guest.label}」を教えてください。`);
      }
      return;
    }

    switch (state.step) {
      case 'ASK_GUEST_NAME': {
        if (state.data.selfMode) state.data.organizerName = text;
        const matches = SheetUtils.findReservation(ss, state.data.organizerName, text);
        if (matches.length === 0) {
          LineApi.reply(replyToken, '該当する予約が見つかりませんでした。');
          StateManager.clear(userId);
          return;
        }
        state.data.guestName = text;
        state.data.rowIndex = matches[0].rowIndex;
        state.step = 'ASK_TARGET';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '何を変更しますか？', this._targets(st).map(k => st[k].label));
        return;
      }

      case 'ASK_TARGET': {
        const key = this._targets(st).find(k => st[k].label === text);
        if (!key) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', this._targets(st).map(k => st[k].label));
          return;
        }
        state.data.target = key;
        this._askNewValue(state, userId, replyToken, ss, st);
        return;
      }

      case 'INPUT_NEW_VALUE': {
        const key = state.data.target;
        if (key === 'staff') {
          const options = [...SheetUtils.getStaffList(ss), ...st.staff.choices];
          if (!options.includes(text)) {
            LineApi.reply(replyToken, '選択肢の中から選んでください。', options);
            return;
          }
        }
        const none = st.note.choices[0] || '特になし';
        state.data.newValue = (key === 'note' && text === none) ? '' : text;
        this._toConfirm(state, userId, replyToken, st, text);
        return;
      }

      case 'INPUT_NEW_VALUE_MENU':
        RegisterFlow._handleMenuSelection(state, userId, replyToken, text, () => {
          state.data.newValue = state.data.treatments.join('、');
          this._toConfirm(state, userId, replyToken, st, state.data.newValue);
        });
        return;

      case 'CONFIRM':
        if (text === 'この内容で変更') {
          this._save(state, userId, replyToken, ss, st);
        } else {
          LineApi.reply(replyToken, '変更を中止しました。');
          StateManager.clear(userId);
        }
        return;

      default:
        StateManager.clear(userId);
    }
  },

  // 設定でONになっていて、変更の対象にできる項目
  _targets(st) {
    return CHANGEABLE_KEYS.filter(k => Settings.isOn(st, k));
  },

  _askNewValue(state, userId, replyToken, ss, st) {
    const key = state.data.target;
    const label = st[key].label;

    if (key === 'staff') {
      state.step = 'INPUT_NEW_VALUE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を選んでください。`,
        [...SheetUtils.getStaffList(ss), ...st.staff.choices]);
    } else if (key === 'menu') {
      const menu = SheetUtils.getMenuList(ss);
      state.data.treatments = [];
      state.data.remainingTreatments = menu.slice(0, MAX_QUICK_REPLIES - 1);
      state.step = 'INPUT_NEW_VALUE_MENU';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を選んでください（複数選択できます）。`,
        [...state.data.remainingTreatments, MENU_DONE]);
    } else {
      // age / gender / note：選択肢があれば出し、自由入力も受け付ける
      state.step = 'INPUT_NEW_VALUE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を入力してください。`, st[key].choices);
    }
  },

  _toConfirm(state, userId, replyToken, st, shownValue) {
    state.step = 'CONFIRM';
    StateManager.set(userId, state);
    const label = st[state.data.target].label;
    LineApi.reply(replyToken, `「${label}」を「${shownValue}」に変更します。よろしいですか？`,
      ['この内容で変更', 'やめる']);
  },

  _save(state, userId, replyToken, ss, st) {
    const d = state.data;
    SheetUtils.updateReservationField(ss, d.rowIndex, d.target, d.newValue);

    // 「要確認」の予約は、変更しても要確認のままにする（満枠の確認が消えないように）
    const current = SheetUtils.getReservations(ss).find(r => r.rowIndex === d.rowIndex);
    if (!current || current.status !== STATUS.PENDING) {
      SheetUtils.updateReservationStatus(ss, d.rowIndex, STATUS.CHANGED);
    }

    LineApi.reply(replyToken, '変更しました。');
    const who = (d.organizerName !== d.guestName)
      ? `${d.organizerName}さんが${d.guestName}さんの予約を` : `${d.guestName}さんが予約を`;
    SheetUtils.notifyOrganizers(`【変更】[${state.eventName}] ${who}変更しました（${st[d.target].label}）。`);
    StateManager.clear(userId);
  },
};

// ===== ConfirmFlow.gs =====
// 「登録確認」フロー：（動員者名→）本人の予約一覧を返信

const ConfirmFlow = {
  start(userId, replyToken, event) {
    const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
    const st = Settings.load(ss);
    const state = {
      flow: 'confirm', step: null,
      spreadsheetUrl: event.spreadsheetUrl, eventName: event.name, data: {},
    };
    Identity.begin(state, userId, replyToken, st, {
      head: `「${event.name}」の登録確認ですね。\n`,
      confirmText: name => `「${name}」さんの予約一覧を表示しますか？`,
      askSelf: 'ご予約時のお名前を教えてください。',
    });
  },

  handle(state, userId, replyToken, text) {
    if (Identity.isOrganizerStep(state)) {
      if (!Identity.handleOrganizerStep(state, userId, replyToken, text)) return;
    } else if (state.step === 'ASK_GUEST_NAME' && state.data.selfMode) {
      state.data.organizerName = text; // 本人モードでは、入力された名前＝予約者
    } else {
      StateManager.clear(userId);
      return;
    }

    const name = state.data.organizerName;
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const st = Settings.load(ss);
    const slotMap = {};
    SheetUtils.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = SheetUtils.slotLabel(s); });

    const reservations = SheetUtils.getReservations(ss)
      .filter(r => String(r.organizer).trim() === String(name).trim() && r.status !== STATUS.CANCELED);

    StateManager.clear(userId);

    if (reservations.length === 0) {
      LineApi.reply(replyToken, '登録されている予約が見つかりませんでした。');
      return;
    }

    const lines = reservations.map(r =>
      `・${r.guest}様／${slotMap[Number(r.slot)] || '枠' + r.slot}／ステータス:${r.status}`);
    LineApi.reply(replyToken, `「${state.eventName}」の${name}さんの予約一覧です。\n` + lines.join('\n'));
  },
};

// ===== CancelFlow.gs =====
// 「キャンセル」フロー：（動員者名→）ゲスト名→確認→ステータス更新

const CancelFlow = {
  start(userId, replyToken, event) {
    const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
    const st = Settings.load(ss);
    const state = {
      flow: 'cancel', step: null,
      spreadsheetUrl: event.spreadsheetUrl, eventName: event.name, data: {},
    };
    Identity.begin(state, userId, replyToken, st, {
      head: `「${event.name}」のキャンセルですね。\n`,
      confirmText: name => `「${name}」さんの予約から探しますか？`,
      askSelf: 'ご予約時のお名前を教えてください。',
    });
  },

  handle(state, userId, replyToken, text) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const st = Settings.load(ss);

    if (Identity.isOrganizerStep(state)) {
      if (Identity.handleOrganizerStep(state, userId, replyToken, text)) {
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `キャンセルする「${st.guest.label}」を教えてください。`);
      }
      return;
    }

    switch (state.step) {
      case 'ASK_GUEST_NAME': {
        if (state.data.selfMode) state.data.organizerName = text;
        const matches = SheetUtils.findReservation(ss, state.data.organizerName, text);
        if (matches.length === 0) {
          LineApi.reply(replyToken, '該当する予約が見つかりませんでした。名前を確認してもう一度お試しください。');
          StateManager.clear(userId);
          return;
        }
        state.data.guestName = text;
        state.data.rowIndex = matches[0].rowIndex; // 動員する人+ゲスト名で一意に決まる前提
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `${text}さんの予約をキャンセルします。よろしいですか？`,
          ['キャンセルする', 'やめる']);
        return;
      }

      case 'CONFIRM':
        if (text === 'キャンセルする') {
          SheetUtils.updateReservationStatus(ss, state.data.rowIndex, STATUS.CANCELED);
          LineApi.reply(replyToken, 'キャンセルしました。');
          const who = (state.data.organizerName !== state.data.guestName)
            ? `${state.data.organizerName}さんが${state.data.guestName}さんの予約を` : `${state.data.guestName}さんが予約を`;
          SheetUtils.notifyOrganizers(`【キャンセル】[${state.eventName}] ${who}キャンセルしました。`);
        } else {
          LineApi.reply(replyToken, 'キャンセルを中止しました。');
        }
        StateManager.clear(userId);
        return;

      default:
        StateManager.clear(userId);
    }
  },
};

// ===== Identity.gs =====
// キャンセル・登録確認・変更の3つのフローで共通する「誰の予約か」を決める最初の質問。
//   ・「動員する人」をONにしている開催：動員する人のお名前（前回の名前があれば確認だけ）
//   ・「動員する人」をOFFにしている開催：ご本人（ゲスト）のお名前を直接聞く（state.data.selfMode = true）

const Identity = {
  // opts: { head, confirmText(lastName), askSelf }
  begin(state, userId, replyToken, st, opts) {
    if (!Settings.isOn(st, 'organizer')) {
      state.data.selfMode = true;
      state.step = 'ASK_GUEST_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, opts.head + opts.askSelf);
      return;
    }
    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken, opts.head + opts.confirmText(lastName), ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      state.step = 'ASK_ORGANIZER_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, opts.head + st.organizer.question);
    }
  },

  // CONFIRM_ORGANIZER_NAME / ASK_ORGANIZER_NAME のステップを処理する。
  // 名前が確定したら true、まだ続きがある（聞き直した）なら false を返す。
  handleOrganizerStep(state, userId, replyToken, text) {
    if (state.step === 'CONFIRM_ORGANIZER_NAME') {
      if (text === 'はい') {
        state.data.organizerName = state.data.organizerNameCandidate;
        return true;
      }
      state.step = 'ASK_ORGANIZER_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, 'お名前を入力してください。');
      return false;
    }
    if (state.step === 'ASK_ORGANIZER_NAME') {
      state.data.organizerName = text;
      return true;
    }
    return false;
  },

  isOrganizerStep(state) {
    return state.step === 'CONFIRM_ORGANIZER_NAME' || state.step === 'ASK_ORGANIZER_NAME';
  },
};

// ===== LineApi.gs =====
// LINE Messaging APIへの返信（reply）とプッシュ通知（push）をまとめたヘルパー。

const LineApi = {
  // choices を渡すとクイックリプライ（タップで同じ文言を送信）が付く
  reply(replyToken, text, choices) {
    const message = { type: 'text', text: text };
    if (choices && choices.length > 0) {
      if (choices.length > MAX_QUICK_REPLIES) {
        console.warn('選択肢が' + MAX_QUICK_REPLIES + '個を超えたため、先頭のみ表示します: ' + choices.length);
      }
      message.quickReply = { items: choices.slice(0, MAX_QUICK_REPLIES).map(this._quickReplyItem) };
    }
    this._call('https://api.line.me/v2/bot/message/reply', {
      replyToken: replyToken,
      messages: [message],
    });
  },

  push(userId, text) {
    this._call('https://api.line.me/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: text }],
    });
  },

  _quickReplyItem(label) {
    const shortLabel = String(label).slice(0, 20); // LINE仕様：ラベルは20文字まで
    return {
      type: 'action',
      action: { type: 'message', label: shortLabel, text: String(label) },
    };
  },

  _call(url, payload) {
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() >= 300) {
      console.error('LINE API error: ' + res.getResponseCode() + ' ' + res.getContentText());
    }
  },
};

// ===== SheetUtils.gs =====
// 親（コントロール）シートと、開催ごとの予約シートファイルへのアクセスをまとめたヘルパー。

const SheetUtils = {
  getControlSheet() {
    return SpreadsheetApp.openById(CONFIG.CONTROL_SHEET_ID);
  },

  // ---------- 開催マスタ ----------

  // 開催マスタの全行（予約シートURLが入っているもの）
  getAllEvents() {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.EVENT_MASTER);
    const rows = sheet.getDataRange().getDisplayValues();
    const header = rows[0];
    const idx = name => header.indexOf(name);
    const iId = idx('開催ID'), iDate = idx('開催日'), iName = idx('開催名');
    const iUrl = idx('予約シートURL'), iStatus = idx('ステータス');

    return rows.slice(1)
      .filter(r => r[iId] !== '' && /\/d\/[a-zA-Z0-9-_]+/.test(r[iUrl]))
      .map(r => {
        const name = (iName >= 0 && r[iName] !== '') ? r[iName] : r[iId];
        const date = iDate >= 0 ? r[iDate] : '';
        const short = Util.shortDate(date);
        return {
          eventId: r[iId],
          name: name,
          date: date,
          label: short ? `${name}（${short}）` : name,
          spreadsheetUrl: r[iUrl],
          status: r[iStatus],
        };
      });
  },

  // 「募集中」の開催（複数可）
  getActiveEvents() {
    return this.getAllEvents().filter(e => e.status === '募集中');
  },

  openReservationSpreadsheet(url) {
    return SpreadsheetApp.openById(this.extractSpreadsheetId(url));
  },

  extractSpreadsheetId(url) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('スプレッドシートURLからIDを取得できません: ' + url);
    return m[1];
  },

  // ---------- 開催別シートの読み込み ----------

  // 枠マスタ（見出しの文字で読む。列の見出しは変えないでください）
  getSlotList(ss) {
    // 開始時刻はタイムゾーン解釈によるズレを避けるため、
    // 数値としてではなく「スプレッドシートに表示されている文字列」をそのまま読み込む
    const sheet = ss.getSheetByName(SHEET_NAMES.SLOT_MASTER);
    const rows = sheet.getDataRange().getDisplayValues();
    const header = rows[0];
    return rows.slice(1)
      .filter(r => r.some(v => v !== ''))
      .map(r => {
        const obj = {};
        header.forEach((h, i) => obj[h] = r[i]);
        return obj;
      })
      .filter(s => s['枠番号'] !== '');
  },

  slotLabel(slot) {
    return `${slot['枠名']}(${slot['開始時刻']})`;
  },

  // 対応者一覧：A列（1列目）の2行目以降。見出しの文字は自由に変えてよい
  getStaffList(ss) {
    return this._firstColumn(ss.getSheetByName(SHEET_NAMES.STAFF_LIST));
  },

  // メニュー：A列（1列目）の2行目以降。「メニュー」タブ、なければ旧「施術メニュー」タブを使う
  getMenuList(ss) {
    for (const name of SHEET_NAMES.MENU_LIST) {
      const sheet = ss.getSheetByName(name);
      if (sheet) return this._firstColumn(sheet);
    }
    return [];
  },

  _firstColumn(sheet) {
    if (!sheet) return [];
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    return sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
      .map(r => String(r[0]).trim()).filter(v => v !== '');
  },

  // 予約タブ：列の位置（RES_COL）で読む。戻り値は { rowIndex, id, slot, organizer, guest, ... }
  getReservations(ss) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, RES_DATA_COLS).getValues();
    const result = [];
    values.forEach((row, i) => {
      // 予約IDもゲスト名も空の行は、数式だけが入った空き行なので読み飛ばす
      if (row[RES_COL.id - 1] === '' && row[RES_COL.guest - 1] === '') return;
      const obj = { rowIndex: i + 2 };
      Object.keys(RES_COL).forEach(key => {
        if (RES_COL[key] <= RES_DATA_COLS) obj[key] = row[RES_COL[key] - 1];
      });
      result.push(obj);
    });
    return result;
  },

  // 指定した枠番号の現在の受付件数（キャンセルを除く）
  countReservationsInSlot(ss, slotNumber) {
    return this.getReservations(ss)
      .filter(r => Number(r.slot) === Number(slotNumber) && r.status !== STATUS.CANCELED)
      .length;
  },

  // ---------- 予約の書き込み ----------

  // 新規予約を1行追加。受付可能人数を超えていれば自動的に「要確認」にする
  appendReservation(ss, data) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);

    const lastRow = sheet.getLastRow();
    const idValues = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat()
      : [];

    // 予約IDは「既存の数値の最大値+1」。空欄行があっても影響を受けない
    const numericIds = idValues.filter(v => typeof v === 'number');
    const newId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;

    // 予約ID列（A列）が空欄になっている最初の行に書き込む。なければ最終行の次に追加する
    const blankIndex = idValues.findIndex(v => v === '' || v === null || v === undefined);
    const targetRow = (blankIndex === -1) ? lastRow + 1 : blankIndex + 2; // +2はA2始まりのオフセット

    const slots = this.getSlotList(ss);
    const slot = slots.find(s => Number(s['枠番号']) === Number(data.slotNumber));
    const capacity = slot ? Number(slot['受付可能人数']) : 0;
    const currentCount = this.countReservationsInSlot(ss, data.slotNumber);
    const status = (currentCount + 1) > capacity ? STATUS.PENDING : STATUS.ACCEPTED;

    sheet.getRange(targetRow, 1, 1, RES_DATA_COLS).setValues([[
      newId,
      data.slotNumber,
      data.organizerName || '',
      data.guestName,
      data.age || '',
      data.gender || '',
      data.staff || '',
      (data.treatments || []).join('、'),
      data.note || '',
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
      status,
      '', // 確定担当者（前日ミーティングで記入）
      '', // 確定枠番号（同上）
      '', // 主催者メモ
    ]]);

    // 枠表示（O列）・重複チェック（P列）は数式で自動計算されるようにする
    // 「$B列が空欄でない」条件を加えて、空欄行同士が誤って重複判定されないようにしている
    sheet.getRange(targetRow, RES_COL.slotLabel).setFormula(
      `=IFERROR(VLOOKUP($B${targetRow},枠マスタ!$A:$E,2,FALSE)&"("&TEXT(VLOOKUP($B${targetRow},枠マスタ!$A:$E,3,FALSE),"HH:mm")&")","")`
    );
    sheet.getRange(targetRow, RES_COL.dup).setFormula(
      `=IF(AND($B${targetRow}<>"",COUNTIFS($B$2:$B,$B${targetRow},$G$2:$G,$G${targetRow},$K$2:$K,"<>キャンセル")>1),"⚠重複あり","")`
    );

    return { reservationId: newId, status: status };
  },

  // 動員する人の名前＋ゲスト名で予約を検索（キャンセル済みは除く）。[{ rowIndex, status }]
  findReservation(ss, organizerName, guestName) {
    return this.getReservations(ss)
      .filter(r => String(r.organizer).trim() === String(organizerName).trim() &&
                   String(r.guest).trim() === String(guestName).trim() &&
                   r.status !== STATUS.CANCELED)
      .map(r => ({ rowIndex: r.rowIndex, status: r.status }));
  },

  updateReservationStatus(ss, rowIndex, status) {
    this.updateReservationField(ss, rowIndex, 'status', status);
  },

  // key は RES_COL のキー名（'staff' 'menu' 'age' 'gender' 'note' 'status' など）
  updateReservationField(ss, rowIndex, key, value) {
    const col = RES_COL[key];
    if (!col) throw new Error('列が見つかりません: ' + key);
    ss.getSheetByName(SHEET_NAMES.RESERVATIONS).getRange(rowIndex, col).setValue(value);
  },

  // ---------- 当日スケジュール・要確認リスト ----------

  // 当日スケジュール（行=枠、列=対応者）を対応者一覧・枠マスタ・予約タブから作り直す。
  // 「確定担当者」が入っている予約だけを反映する。同じ枠・同じ対応者に2人以上いる
  // セルはオレンジ色で目立たせる。戻り値は重複セルの件数。
  buildDaySchedule(ss) {
    const st = Settings.load(ss);
    let sheet = ss.getSheetByName(SHEET_NAMES.DAY_SCHEDULE);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.DAY_SCHEDULE);
    sheet.clear();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearNote();

    const staffList = this.getStaffList(ss);
    const slots = this.getSlotList(ss)
      .sort((a, b) => Number(a['枠番号']) - Number(b['枠番号']));

    sheet.getRange(1, 1).setValue(`枠＼${st.staff_role.label}`);
    staffList.forEach((staff, i) => sheet.getRange(1, 2 + i).setValue(staff));
    slots.forEach((slot, i) => {
      sheet.getRange(2 + i, 1).setValue(this.slotLabel(slot));
    });

    if (staffList.length > 0) {
      sheet.getRange(1, 1, 1, staffList.length + 1)
        .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
      // ゲスト名・メニューまで表示すると横幅が必要なので、対応者の列を広めにしておく
      for (let i = 0; i < staffList.length; i++) {
        sheet.setColumnWidth(2 + i, 220);
      }
    }
    if (slots.length > 0) {
      sheet.getRange(1, 1, slots.length + 1, 1)
        .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    }
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);

    // 「確定担当者」が入っている予約（キャンセル除く）だけを集計する
    const reservations = this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && r.confirmedStaff);

    const cellMap = {}; // "枠番号|担当者名" -> ["ゲスト名\n（動員する人）\nメニュー", ...]
    reservations.forEach(r => {
      const slotNumber = (r.confirmedSlot !== '' && r.confirmedSlot !== undefined) ? r.confirmedSlot : r.slot;
      const key = slotNumber + '|' + r.confirmedStaff;
      if (!cellMap[key]) cellMap[key] = [];
      const lines = [r.guest];
      // 動員する人をOFFにしている開催では、動員する人＝ゲスト名なので表示しない
      if (Settings.isOn(st, 'organizer') && r.organizer) lines.push(`（${r.organizer}）`);
      if (r.menu) lines.push(r.menu);
      cellMap[key].push(lines.join('\n'));
    });

    let duplicateCount = 0;
    slots.forEach((slot, rowOffset) => {
      staffList.forEach((staff, colOffset) => {
        const entries = cellMap[String(slot['枠番号']) + '|' + staff];
        if (!entries) return;
        const cell = sheet.getRange(2 + rowOffset, 2 + colOffset);
        // 1件＝最大3行（ゲスト名／動員する人／メニュー）。複数件ある場合は空行で区切って積む
        cell.setValue(entries.join('\n\n')).setWrap(true).setVerticalAlignment('top');
        if (entries.length > 1) {
          cell.setBackground('#FDECC8'); // 1人が複数ゲストを担当＝重複を目立たせる
          duplicateCount++;
        }
      });
    });

    // 複数人が入っているセル（改行あり）があっても読めるよう、全体の行の高さを自動調整する
    if (slots.length > 0 && staffList.length > 0) {
      sheet.autoResizeRows(2, slots.length);
    }

    return duplicateCount;
  },

  // 要確認リスト：ステータスが「要確認」の予約だけを一覧にする。戻り値は件数
  buildPendingList(ss) {
    const st = Settings.load(ss);
    let sheet = ss.getSheetByName(SHEET_NAMES.PENDING_LIST);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.PENDING_LIST);
    sheet.clear();

    const header = ['予約ID', '枠', st.organizer.label, st.guest.label, st.staff.label, '登録日時', '主催者メモ'];
    sheet.getRange(1, 1, 1, header.length).setValues([header])
      .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);

    const slotMap = {};
    this.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = this.slotLabel(s); });

    const rows = this.getReservations(ss)
      .filter(r => r.status === STATUS.PENDING)
      .map(r => [r.id, slotMap[Number(r.slot)] || r.slot, r.organizer, r.guest, r.staff, r.createdAt, r.memo]);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
    return rows.length;
  },

  // ---------- 通知 ----------

  // 主催者通知先（通知ON/OFF=ONの人）全員にLINE通知
  notifyOrganizers(message) {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.NOTIFY_LIST);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    const idxId = header.indexOf('LINE User ID');
    const idxOnOff = header.indexOf('通知ON/OFF');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][idxOnOff] === 'ON' && rows[i][idxId]) {
        LineApi.push(rows[i][idxId], message);
      }
    }
  },
};

// ===== StateManager.gs =====
// ・会話の途中経過（今どのステップか、これまでの入力内容）はCacheServiceに一時保存します。
//   30分操作がないと自動的に消え、最初からやり直しになります。
// ・「動員する人の名前」は毎回聞き直さなくて済むよう、PropertiesServiceに長期保存します。

const StateManager = {
  get(userId) {
    const raw = CacheService.getScriptCache().get('state_' + userId);
    return raw ? JSON.parse(raw) : null;
  },

  set(userId, state) {
    CacheService.getScriptCache().put('state_' + userId, JSON.stringify(state), STATE_CACHE_SECONDS);
  },

  clear(userId) {
    CacheService.getScriptCache().remove('state_' + userId);
  },

  getLastOrganizerName(userId) {
    return PropertiesService.getScriptProperties().getProperty('organizer_' + userId);
  },

  setLastOrganizerName(userId, name) {
    PropertiesService.getScriptProperties().setProperty('organizer_' + userId, name);
  },
};

// ===== Util.gs =====
const Util = {
  // 全角数字を半角に（「１」と入力されても番号として扱えるように）
  toHalfWidth(s) {
    return String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  },

  // 「{no}」のような差し込み文字を置き換える
  fillTemplate(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  },

  // 「2026/10/3」「2026-10-03」「20261003」「2026年10月3日」などを yyyymmdd と Date にする。失敗したら null
  parseDate(text) {
    const s = this.toHalfWidth(text);
    const m = s.match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    const pad = n => (n < 10 ? '0' + n : String(n));
    return { date: date, yyyymmdd: '' + y + pad(mo) + pad(d), display: y + '/' + pad(mo) + '/' + pad(d) };
  },

  // 表示用の短い日付「10/3」。取れなければ空文字
  shortDate(text) {
    const m = String(text).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? Number(m[2]) + '/' + Number(m[3]) : '';
  },
};
