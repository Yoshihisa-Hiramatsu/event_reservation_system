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
// enabled を false にできる項目: organizer / slot / age / gender / staff / menu / note / waitlist
// （guest は必須なので常にON。slot をOFFにすると時間枠を使わない開催＝全員同じ開始時刻のイベントになる）
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
  // 満席の枠を選べるようにするか。ON：満席でもキャンセル待ち（要確認）として受け付ける／OFF：満席の枠は出さず、受け付けない
  waitlist: { label: '満席でも受け付ける', enabled: true, choices: [] },
  // 全部の枠が満席のとき、登録を始める前に聞く文（このあと［進める］［やめる］を出す）
  msg_full: { label: '満席メッセージ',
    text: '申し訳ありません。現在は満席です。キャンセル待ち（要確認）としての登録になりますが、登録を進めますか？',
    enabled: true, choices: [] },
  // 「満席でも受け付ける」がOFFで、全部の枠が満席のときの返信
  msg_closed: { label: '受付終了メッセージ',
    text: '申し訳ありません。ご希望いただける枠は満席のため、受付できません。', enabled: true, choices: [] },
  // 同じ枠で同じ対応者を希望する人がすでにいるときの注意（{staff} は対応者名）
  msg_overlap: { label: '希望重複メッセージ',
    text: '※この枠の「{staff}」さんは、すでに他の方のご希望があります。担当者が変わる可能性があります。',
    enabled: true, choices: [] },
  msg_pending: { label: '要確認メッセージ',
    text: '現在満枠のため「要確認」として登録しました（予約No.{no}）。主催者確認後、あらためてご連絡します。',
    enabled: true, choices: [] },
};

// 会話状態（CacheService）の保持時間。この時間操作がないと最初からやり直しになる
const STATE_CACHE_SECONDS = 1800; // 30分

// LINEのクイックリプライは最大13個
const MAX_QUICK_REPLIES = 13;

// ===== Main.gs =====
// LINEからのWebhookを受け取る入口。
// Webアプリとしてデプロイし、そのURLをLINE DevelopersのWebhook URLに設定してください。

function doPost(e) {
  // 同じ人の操作が重なって会話の状態が上書きされないよう、処理を1件ずつ順番に行う
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(25000);
  } catch (err) {
    console.warn('ロックを取得できませんでした: ' + err);
  }
  try {
    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];
    events.forEach(safeHandleEvent);
  } catch (err) {
    console.error('doPost error: ' + err + '\n' + (err && err.stack));
  } finally {
    if (locked) lock.releaseLock();
  }
  // LINE Platformへは常に200 OKを返す
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 1件の処理で例外が出ても、利用者に何も返らないままにならないよう、お詫びの返信を送る
function safeHandleEvent(event) {
  try {
    handleEvent(event);
  } catch (err) {
    console.error('handleEvent error: ' + err + '\n' + (err && err.stack));
    try {
      if (event && event.replyToken && event.type === 'message') {
        LineApi.reply(event.replyToken,
          'うまく処理できませんでした。お手数ですが、もう一度お送りください。うまくいかないときは「リセット」と送ると最初からやり直せます。');
      }
    } catch (err2) {
      console.error('error reply failed: ' + err2);
    }
  }
}

function handleEvent(event) {
  const userId = event.source && event.source.userId;
  if (!userId) return;

  // LINEが同じ通知を再送してきたときに、二重に処理しない
  if (event.webhookEventId) {
    const cache = CacheService.getScriptCache();
    const key = 'ev_' + event.webhookEventId;
    if (cache.get(key)) return;
    cache.put(key, '1', 600);
  }

  if (event.type === 'message' && event.message.type === 'text') {
    handleTextMessage(userId, event.replyToken, event.message.text.trim());
  }
  // 将来リッチメニューをpostback形式にする場合はここにhandlePostbackを追加
}

// 「通知登録 合言葉」「通知解除」：主催者がLINEから通知先に入る・外れる。処理したら true
function handleNotifyCommand(userId, replyToken, text) {
  const m = text.match(/^通知登録(?:[\s\u3000]+(.*))?$/);
  if (m) {
    const passcode = Util.toHalfWidth(SheetUtils.getNotifyPasscode());
    if (passcode === '') {
      LineApi.reply(replyToken, 'この操作は現在ご利用いただけません。');
      return true;
    }
    const given = Util.toHalfWidth((m[1] || '').trim());
    if (given === '') {
      LineApi.reply(replyToken, '「通知登録 合言葉」の形でお送りください。');
      return true;
    }
    if (given !== passcode) {
      LineApi.reply(replyToken, '合言葉が違います。');
      return true;
    }
    const result = SheetUtils.setNotifyUser(userId, LineApi.getDisplayName(userId) || '（LINEから登録）', true);
    LineApi.reply(replyToken, result === 'added'
      ? '通知先に登録しました。今後、新規登録・変更・キャンセルの通知が届きます。'
      : '通知をONにしました。');
    return true;
  }
  if (text === '通知解除') {
    const result = SheetUtils.setNotifyUser(userId, '', false);
    LineApi.reply(replyToken, result === 'off' ? '通知をOFFにしました。' : '通知先に登録されていません。');
    return true;
  }
  return false;
}

function handleTextMessage(userId, replyToken, text) {
  // 会話が止まってしまった場合の緊急リセット用
  if (text === 'リセット') {
    StateManager.clear(userId);
    LineApi.reply(replyToken, '操作をリセットしました。「登録」「キャンセル」「登録確認」「変更」「空き枠確認」のいずれかを送ってください。');
    return;
  }

  if (handleNotifyCommand(userId, replyToken, text)) return;

  const state = StateManager.get(userId);

  if (!state) {
    // 会話中でない場合は、トリガーワードとして判定する
    const flow = matchTrigger(text);
    if (flow) {
      startFlow(flow, userId, replyToken);
    } else {
      LineApi.reply(replyToken,
        'メニューから「登録」「キャンセル」「登録確認」「変更」「空き枠確認」のいずれかを送ってください。');
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
  if (text === '空き枠確認') return 'avail';
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
    case 'avail': return AvailFlow.start(userId, replyToken, event);
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
    .addItem('設定の読み込みを確認', 'menu_checkSettings')
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
  if (!Settings.isOn(Settings.load(ss), 'slot')) {
    lines.push('時間枠を使わない開催なので、当日スケジュールは参加者の一覧（名簿）として作成しました。');
  } else {
    lines.push(duplicateCount > 0
      ? `同じ対応者に複数ゲストが割り当てられているセルが ${duplicateCount} 件あります（オレンジ色のセル）。`
      : '当日スケジュールに重複はありません。');
  }
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

// ---------- 設定の読み込みを確認 ----------
// LINEのBotが「どのファイルの設定タブを、どう読んでいるか」を表示する
function menu_checkSettings() {
  const ui = SpreadsheetApp.getUi();
  const event = EventAdmin.pickEvent_('設定を確認する開催を選んでください');
  if (!event) return;
  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  ui.alert('設定の読み込み結果', Settings.describe(ss, event.name), ui.ButtonSet.OK);
}

// ===== Settings.gs =====
// 開催別シートの「設定」タブを読み込む。タブが無い・空欄・「…」だけの項目は、Config.gsの初期値を使う。
//
// 設定タブの列：A=内部キー / B=表示名 / C=LINEの質問文（msg_で始まる行は返信メッセージ）/ D=使う(ON/OFF) / E=選択肢
// 選択肢はカンマ（, 、 ，）区切り。

const Settings = {
  REQUIRED: ['guest'], // OFFにできない項目

  load(ss) {
    const st = {};
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      st[key] = Object.assign({}, DEFAULT_SETTINGS[key], { choices: DEFAULT_SETTINGS[key].choices.slice() });
    });

    const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    if (sheet) {
      sheet.getDataRange().getDisplayValues().slice(1).forEach(r => {
        const key = Util.toHalfWidth(r[0]).trim();
        const item = st[key];
        if (!item) return;

        const label = this._text(r[1]);
        if (label) item.label = label;

        const body = this._text(r[2]);
        if (body) {
          if (key.indexOf('msg_') === 0) item.text = body; else item.question = body;
        }

        const onoff = this._onoff(r[3]);
        if (onoff === 'OFF') item.enabled = false;
        if (onoff === 'ON') item.enabled = true;

        const choices = this._choices(r[4]);
        if (choices.length > 0) item.choices = choices;
      });
    }
    this.REQUIRED.forEach(key => { st[key].enabled = true; });
    return st;
  },

  // 「ON」「OFF」のほか、全角・小文字・「オフ」「×」なども読み取る。判定できなければ ''
  _onoff(value) {
    const v = Util.toHalfWidth(value === null || value === undefined ? '' : value).trim().toUpperCase();
    if (['OFF', 'オフ', '×', '✕', 'NO', 'いいえ', '使わない'].indexOf(v) !== -1) return 'OFF';
    if (['ON', 'オン', '○', '〇', 'YES', 'はい', '使う'].indexOf(v) !== -1) return 'ON';
    return '';
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

  // 「どのファイルの設定を、どう読み込んだか」を確認用の文章にする（親シートのメニューから使う）
  describe(ss, eventName) {
    const lines = [`開催：${eventName}`, `読み込んだファイル：${ss.getName()}`];
    const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    if (!sheet) {
      lines.push('', '⚠ このファイルに「設定」タブがありません。標準の文言（美容版）で動いています。');
      return lines.join('\n');
    }
    const st = this.load(ss);
    const rows = sheet.getDataRange().getDisplayValues().slice(1);
    const known = Object.keys(DEFAULT_SETTINGS);
    lines.push('');
    rows.forEach(r => {
      const key = Util.toHalfWidth(r[0]).trim();
      if (key === '') return;
      if (known.indexOf(key) === -1) {
        lines.push(`⚠ 「${key}」は認識できない内部キーです（無視されます）`);
        return;
      }
      const item = st[key];
      const body = key.indexOf('msg_') === 0 ? item.text : item.question;
      const sheetBody = String(r[2]).trim();
      const ignored = sheetBody !== '' && this._text(sheetBody) === '';
      const flag = this.REQUIRED.indexOf(key) !== -1 ? 'ON(必須)' : (item.enabled ? 'ON' : 'OFF');
      lines.push(`${key}：${flag}／${item.label}` + (body ? `／${body}` : '') + (ignored ? '　※質問文が「…」で終わっているため標準の文言を使用' : ''));
    });
    const missing = known.filter(k => !rows.some(r => Util.toHalfWidth(r[0]).trim() === k));
    if (missing.length > 0) lines.push('', '設定タブに無い行（標準の設定を使用）：' + missing.join(', '));
    return lines.join('\n');
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
const REGISTER_QUIT = 'やめる';
// 「やめる」で登録を中止できるステップ（メニュー選択はボタンの余裕がないので、文字で入力したときだけ効く）
const REGISTER_QUIT_STEPS = ['CONFIRM_WAITLIST', 'CONFIRM_ORGANIZER_NAME', 'ASK_ORGANIZER_NAME', 'ASK_GUEST',
  'ASK_SLOT', 'ASK_AGE', 'ASK_GENDER', 'ASK_STAFF', 'ASK_MENU', 'ASK_NOTE'];

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

    // すべて満席のときは、登録を始める前にお知らせする。
    //   「満席でも受け付ける」がON：キャンセル待ち（要確認）として進めるかを聞く／OFF：受付できないと伝えて終わる
    const full = Settings.isOn(st, 'slot') ? this._allSlotsFull(ss) : SheetUtils.isEventFull(ss);
    if (full) {
      if (!Settings.isOn(st, 'waitlist')) {
        LineApi.reply(replyToken, head + st.msg_closed.text);
        return;
      }
      state.step = 'CONFIRM_WAITLIST';
      state.data.waitlist = true;
      state.data.waitlistAck = true;
      StateManager.set(userId, state);
      let ask = st.msg_full.text;
      if (!/[？?]\s*$/.test(ask)) ask += '\n登録を進めますか？';
      LineApi.reply(replyToken, head + ask, ['進める', REGISTER_QUIT]);
      return;
    }
    this._begin(state, userId, replyToken, ss, st, head);
  },

  // 時間枠があり、すべての枠が満席
  _allSlotsFull(ss) {
    return SheetUtils.getSlotList(ss).length > 0 && SheetUtils.getAvailableSlots(ss).length === 0;
  },

  // 動員する人（またはゲスト名）の質問から始める
  _begin(state, userId, replyToken, ss, st, head) {
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
        ['はい', 'いいえ（別の名前を入力する）', REGISTER_QUIT]);
    } else {
      state.step = 'ASK_ORGANIZER_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, head + st.organizer.question, [REGISTER_QUIT]);
    }
  },

  // 選択肢の末尾に「やめる」を付ける（クイックリプライは13個まで）
  _withQuit(list) {
    return list.slice(0, MAX_QUICK_REPLIES - 1).concat(REGISTER_QUIT);
  },

  // 時間枠の選択肢。「満席でも受け付ける」がONなら満席の枠も出す
  _slotChoices(ss, st) {
    const slots = Settings.isOn(st, 'waitlist') ? SheetUtils.getSlotList(ss) : SheetUtils.getAvailableSlots(ss);
    return this._withQuit(slots.map(s => SheetUtils.slotLabel(s)));
  },

  // 同じ枠・同じ希望対応者の予約がすでにあるときの注意文（なければ空文字）
  _overlapNotice(ss, st, slotNumber, staff, excludeRowIndex) {
    if (!Settings.isOn(st, 'staff')) return '';
    if (staff === undefined || staff === null || staff === '') return '';
    if (st.staff.choices.indexOf(staff) !== -1) return ''; // 「誰でも良い」などは対象外
    return SheetUtils.countSameStaff(ss, slotNumber, staff, excludeRowIndex) > 0
      ? Util.fillTemplate(st.msg_overlap.text, { staff: staff }) : '';
  },

  handle(state, userId, replyToken, text) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const st = Settings.load(ss);
    const d = state.data;

    if (text === REGISTER_QUIT && REGISTER_QUIT_STEPS.indexOf(state.step) !== -1) {
      StateManager.clear(userId);
      LineApi.reply(replyToken, '登録を中止しました。最初からやり直す場合は「登録」と送ってください。');
      return;
    }

    switch (state.step) {
      case 'CONFIRM_WAITLIST':
        if (text === '進める') {
          this._begin(state, userId, replyToken, ss, st, '');
        } else {
          LineApi.reply(replyToken, '「進める」か「やめる」を選んでください。', ['進める', REGISTER_QUIT]);
        }
        return;

      case 'CONFIRM_ORGANIZER_NAME':
        if (text === 'はい') {
          d.organizerName = d.organizerNameCandidate;
          this._next(state, userId, replyToken, ss, st, null, '');
        } else {
          state.step = 'ASK_ORGANIZER_NAME';
          StateManager.set(userId, state);
          LineApi.reply(replyToken, 'お名前を入力してください。', [REGISTER_QUIT]);
        }
        return;

      case 'ASK_ORGANIZER_NAME':
        d.organizerName = text;
        StateManager.setLastOrganizerName(userId, text);
        this._next(state, userId, replyToken, ss, st, null, '');
        return;

      case 'ASK_GUEST':
        d.guestName = text;
        // 「動員する人」をOFFにしている開催では、動員する人の列は空欄のまま（本人の予約として保存する）
        this._next(state, userId, replyToken, ss, st, 'guest', '');
        return;

      case 'ASK_SLOT': {
        // 「満席でも受け付ける」がOFFなら、満席の枠は選べない（選んでいる間に埋まった場合も、ここで弾く）
        const allowFull = Settings.isOn(st, 'waitlist');
        const available = SheetUtils.getAvailableSlots(ss);
        const pool = allowFull ? SheetUtils.getSlotList(ss) : available;
        const slot = pool.find(s => SheetUtils.slotLabel(s) === text);
        if (!slot) {
          if (available.length === 0) {
            if (!allowFull) {
              StateManager.clear(userId);
              LineApi.reply(replyToken, st.msg_closed.text);
              return;
            }
            // 迷っている間に全部埋まった → キャンセル待ち（要確認）として続ける
            d.waitlist = true;
            d.slotNumber = '';
            d.slotText = '';
            this._next(state, userId, replyToken, ss, st, 'slot',
              '申し訳ありません。お選びいただく間に満席になりました。キャンセル待ち（要確認）として登録を続けます。\n\n');
            return;
          }
          LineApi.reply(replyToken, '選択肢の中から選んでください。', this._slotChoices(ss, st));
          return;
        }
        d.slotNumber = slot['枠番号'];
        d.slotText = SheetUtils.slotLabel(slot);
        d.slotFull = !available.some(s => Number(s['枠番号']) === Number(slot['枠番号']));
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
        const options = [...SheetUtils.getStaffForSlot(ss, d.slotNumber), ...st.staff.choices];
        if (!options.includes(text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', this._withQuit(options));
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
      const asked = this._ask(state, userId, replyToken, ss, st, key, prefix);
      if (asked === true) return;
      // 満席のお知らせは、次の質問の前に付けて1通で送る
      if (asked && asked.notice) prefix += asked.notice + '\n\n';
    }
    state.step = 'CONFIRM';
    StateManager.set(userId, state);
    LineApi.reply(replyToken, prefix + this._buildConfirmText(state, st, ss), ['この内容で登録', 'やり直す']);
  },

  // 1項目ぶんの質問を送る。選択肢が1つも無くて飛ばした場合は false を返す
  _ask(state, userId, replyToken, ss, st, key, prefix) {
    const question = prefix + st[key].question;

    switch (key) {
      case 'guest':
        state.step = 'ASK_GUEST';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, [REGISTER_QUIT]);
        return true;

      case 'slot': {
        const slots = SheetUtils.getSlotList(ss);
        if (slots.length === 0) {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '現在選べる時間枠がありません。主催者にご確認ください。');
          return true;
        }
        const available = SheetUtils.getAvailableSlots(ss);
        const allowFull = Settings.isOn(st, 'waitlist');
        // 登録を始めたあとに空きが出た場合は、通常どおり枠を選んでもらう
        if (state.data.waitlistAck && available.length > 0) state.data.waitlist = false;
        if (available.length === 0) {
          // 全部満席。「満席でも受け付ける」がOFFなら受付終了、ONならキャンセル待ち（要確認）として続ける
          if (!allowFull) {
            StateManager.clear(userId);
            LineApi.reply(replyToken, st.msg_closed.text);
            return true;
          }
          state.data.waitlist = true;
          state.data.slotNumber = '';
          state.data.slotText = '';
          // 登録を始める前に「進める」と答えている場合は、もう一度お知らせしない
          return { notice: state.data.waitlistAck ? '' :
            '申し訳ありません。ご希望いただける枠は満席です。キャンセル待ち（要確認）として登録を続けます。' };
        }
        // 満席の枠も選べるときは、その枠がキャンセル待ちになることを質問の下に添える
        let note = '';
        if (allowFull) {
          const fullNames = SheetUtils.getSlotAvailability(ss).filter(a => a.remaining <= 0)
            .map(a => `「${SheetUtils.slotLabel(a.slot)}」`);
          if (fullNames.length > 0) note = `\n※${fullNames.join('')}はキャンセル待ち（要確認）での受付になります。`;
        }
        state.step = 'ASK_SLOT';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question + note, this._slotChoices(ss, st));
        return true;
      }

      case 'age':
      case 'gender':
        state.step = key === 'age' ? 'ASK_AGE' : 'ASK_GENDER';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, this._withQuit(st[key].choices));
        return true;

      case 'staff': {
        // 選んだ枠で対応できる人だけを出す（誰も対応できない枠では、この質問は飛ばす）
        const staffList = SheetUtils.getStaffForSlot(ss, state.data.slotNumber);
        if (staffList.length === 0) return false;
        state.step = 'ASK_STAFF';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, question, this._withQuit([...staffList, ...st.staff.choices]));
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
        LineApi.reply(replyToken, question, this._withQuit(st.note.choices));
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

  _buildConfirmText(state, st, ss) {
    const d = state.data;
    const lines = [
      `「${state.eventName}」に以下の内容で登録します。よろしいですか？`,
      `${st.guest.label}：${d.guestName}`,
    ];
    if (Settings.isOn(st, 'slot') && d.slotText) lines.push(`${st.slot.label}：${d.slotText}`);
    if (Settings.isOn(st, 'age') && d.age !== undefined) lines.push(`${st.age.label}：${d.age}`);
    if (Settings.isOn(st, 'gender') && d.gender !== undefined) lines.push(`${st.gender.label}：${d.gender}`);
    if (d.staff !== undefined) lines.push(`${st.staff.label}：${d.staff}`);
    if (d.treatments) lines.push(`${st.menu.label}：${d.treatments.join('、')}`);
    if (Settings.isOn(st, 'note')) lines.push(`${st.note.label}：${d.note || 'なし'}`);
    if (d.waitlist || d.slotFull) lines.push('※満席のため、キャンセル待ち（要確認）としての登録になります。');
    const overlap = ss ? this._overlapNotice(ss, st, d.slotNumber, d.staff) : '';
    if (overlap) lines.push(overlap);
    return lines.join('\n');
  },

  _save(state, userId, replyToken, ss, st) {
    const d = state.data;
    d.slotOff = !Settings.isOn(st, 'slot');
    // 同じ枠・同じ希望対応者の予約がすでにあるか（自分の行を足す前に調べる）
    const overlap = d.waitlist ? '' : this._overlapNotice(ss, st, d.slotNumber, d.staff);
    const result = SheetUtils.appendReservation(ss, d);
    StateManager.clear(userId);

    const template = (result.status === STATUS.ACCEPTED) ? st.msg_accepted.text : st.msg_pending.text;
    LineApi.reply(replyToken, Util.fillTemplate(template, { no: result.reservationId }) + (overlap ? '\n' + overlap : ''));

    // 「動員する人」がいない（OFF）、または本人の予約なら、ゲスト名だけで表す
    const who = (d.organizerName && d.organizerName !== d.guestName)
      ? `${d.organizerName}さんが${d.guestName}さんを` : `${d.guestName}さんが`;
    SheetUtils.notifyOrganizers(
      `【新規登録】[${state.eventName}] ${who}登録しました（${[d.slotText, 'ステータス:' + result.status].filter(Boolean).join(' / ')}）` +
      (overlap ? `\n⚠同じ枠で同じ希望対応者（${d.staff}）の予約が重なっています。` : '')
    );
  },
};

// ===== ChangeFlow.gs =====
// 「変更」フロー：時間枠・希望対応者・メニュー・伝達事項（設定でONの項目）を変更できる。
// ゲスト名を変えたい場合は、キャンセル→登録し直しの運用とする（合意済み）。

// 変更できる項目（設定でONのものだけ）。年齢・性別は入力ミスの訂正用
const CHANGEABLE_KEYS = ['slot', 'staff', 'menu', 'age', 'gender', 'note'];
const CHANGE_QUIT = 'やめる';

const ChangeFlow = {
  DONE: 'ない（確認へ進む）',

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
        Identity.showList(state, userId, replyToken, ss, '変更');
      }
      return;
    }

    switch (state.step) {
      // 本人モード（動員する人OFF）：入力された名前＝予約した人
      case 'ASK_GUEST_NAME':
        state.data.organizerName = text;
        Identity.showList(state, userId, replyToken, ss, '変更');
        return;

      // 一覧を見て、番号または名前で変更する予約を選ぶ
      case 'PICK_RESERVATION': {
        if (text === 'やめる') {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '変更を中止しました。');
          return;
        }
        const picked = Identity.pick(state, replyToken, ss, text);
        if (picked.done) return;
        const target = picked.reservation;
        state.data.guestName = target.guest;
        state.data.rowIndex = target.rowIndex;
        state.data.reservationId = target.id;
        state.step = 'ASK_TARGET';
        StateManager.set(userId, state);
        LineApi.reply(replyToken,
          `No.${target.id} ${target.guest}さんの予約を変更します。\n${Identity.describe(ss, st, target)}\n何を変更しますか？`,
          [...this._targets(st).map(k => st[k].label), CHANGE_QUIT]);
        return;
      }

      case 'ASK_TARGET': {
        if (text === CHANGE_QUIT) {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '変更を中止しました。');
          return;
        }
        const key = this._targets(st).find(k => st[k].label === text);
        if (!key) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', [...this._targets(st).map(k => st[k].label), CHANGE_QUIT]);
          return;
        }
        state.data.target = key;
        state.data.updates = {};
        this._askNewValue(state, userId, replyToken, ss, st);
        return;
      }

      // 他にも変更する項目があるかを聞く
      case 'ASK_MORE': {
        if (text === CHANGE_QUIT) {
          StateManager.clear(userId);
          LineApi.reply(replyToken, '変更を中止しました。');
          return;
        }
        if (text === ChangeFlow.DONE) {
          this._toConfirm(state, userId, replyToken, ss, st);
          return;
        }
        const key = this._remaining(state, st).find(k => st[k].label === text);
        if (!key) {
          this._askMore(state, userId, replyToken, ss, st, '選択肢の中から選んでください。\n');
          return;
        }
        state.data.target = key;
        this._askNewValue(state, userId, replyToken, ss, st);
        return;
      }

      // 新しい時間枠（空きのある枠だけ。いまの枠は除く）
      case 'INPUT_NEW_SLOT': {
        const current = this._current(ss, state);
        const slot = this._availableSlots(ss, current).find(s => SheetUtils.slotLabel(s) === text);
        if (!slot) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。',
            this._availableSlots(ss, current).map(s => SheetUtils.slotLabel(s)));
          return;
        }
        state.data.updates.slot = slot['枠番号'];
        // 希望する対応者が、新しい枠に対応していなければ、選び直してもらう
        if (Settings.isOn(st, 'staff') && current.staff !== '' && current.staff !== undefined) {
          const eligible = SheetUtils.getStaffForSlot(ss, slot['枠番号']);
          if (eligible.indexOf(current.staff) === -1 && st.staff.choices.indexOf(current.staff) === -1) {
            const options = [...eligible, ...st.staff.choices];
            if (options.length > 0) {
              state.step = 'INPUT_STAFF_AFTER_SLOT';
              StateManager.set(userId, state);
              LineApi.reply(replyToken,
                `「${current.staff}」さんは${SheetUtils.slotLabel(slot)}に対応できません。\n新しい「${st.staff.label}」を選んでください。`,
                options);
              return;
            }
            state.data.updates.staff = '';
          }
        }
        this._askMore(state, userId, replyToken, ss, st, '');
        return;
      }

      case 'INPUT_STAFF_AFTER_SLOT': {
        const options = [...SheetUtils.getStaffForSlot(ss, state.data.updates.slot), ...st.staff.choices];
        if (!options.includes(text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', options);
          return;
        }
        state.data.updates.staff = text;
        this._askMore(state, userId, replyToken, ss, st, '');
        return;
      }

      case 'INPUT_NEW_VALUE': {
        const key = state.data.target;
        if (key === 'staff') {
          const options = [...this._staffOptions(ss, st, state.data.rowIndex)];
          if (!options.includes(text)) {
            LineApi.reply(replyToken, '選択肢の中から選んでください。', options);
            return;
          }
        }
        const none = st.note.choices[0] || '特になし';
        state.data.updates[key] = (key === 'note' && text === none) ? '' : text;
        this._askMore(state, userId, replyToken, ss, st, '');
        return;
      }

      case 'INPUT_NEW_VALUE_MENU':
        RegisterFlow._handleMenuSelection(state, userId, replyToken, text, () => {
          state.data.updates.menu = state.data.treatments.join('、');
          this._askMore(state, userId, replyToken, ss, st, '');
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

  // まだ変更していない項目（変更先の空きがなくて選べない項目は除く）
  _remaining(state, st) {
    const done = Object.keys(state.data.updates || {});
    const unavailable = state.data.unavailable || [];
    return this._targets(st).filter(k => done.indexOf(k) === -1 && unavailable.indexOf(k) === -1);
  },

  // 「他に変更しますか？」。変更した項目が1つ以上あれば「ない（確認へ進む）」も出す
  _askMore(state, userId, replyToken, ss, st, prefix) {
    const remaining = this._remaining(state, st);
    const changed = Object.keys(state.data.updates || {}).length > 0;
    if (remaining.length === 0) {
      if (!changed) {
        StateManager.clear(userId);
        LineApi.reply(replyToken, prefix + '変更できる項目がありません。');
        return;
      }
      this._toConfirm(state, userId, replyToken, ss, st); // 全部変更ずみ → そのまま確認へ
      return;
    }
    state.step = 'ASK_MORE';
    StateManager.set(userId, state);
    const choices = remaining.map(k => st[k].label);
    if (changed) choices.push(ChangeFlow.DONE);
    choices.push(CHANGE_QUIT);
    LineApi.reply(replyToken, prefix + '他に変更する項目はありますか？', choices);
  },

  _current(ss, state) {
    return SheetUtils.getReservations(ss).find(r => r.rowIndex === state.data.rowIndex);
  },

  // 変更先に選べる時間枠：空きがある枠（いまの枠は除く）
  _availableSlots(ss, current) {
    return SheetUtils.getAvailableSlots(ss)
      .filter(s => !(current && current.slot !== '' && Number(s['枠番号']) === Number(current.slot)));
  },

  // 変更対象の予約の枠で対応できる人（枠が無い予約は全員）＋「誰でも良い」など
  _staffOptions(ss, st, rowIndex) {
    const r = SheetUtils.getReservations(ss).find(x => x.rowIndex === rowIndex);
    return [...SheetUtils.getStaffForSlot(ss, r ? r.slot : ''), ...st.staff.choices];
  },

  // 設定でONになっていて、変更の対象にできる項目
  _targets(st) {
    return CHANGEABLE_KEYS.filter(k => Settings.isOn(st, k));
  },

  _askNewValue(state, userId, replyToken, ss, st) {
    const key = state.data.target;
    const label = st[key].label;

    if (key === 'slot') {
      const options = this._availableSlots(ss, this._current(ss, state));
      if (options.length === 0) {
        // 空き枠がないときは、他の項目の選択に戻す
        state.data.unavailable = (state.data.unavailable || []).concat('slot');
        this._askMore(state, userId, replyToken, ss, st, `申し訳ありません。現在、変更できる空きの${label}がありません。\n`);
        return;
      }
      state.step = 'INPUT_NEW_SLOT';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を選んでください。`, options.map(s => SheetUtils.slotLabel(s)));
    } else if (key === 'staff') {
      state.step = 'INPUT_NEW_VALUE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を選んでください。`,
        this._staffOptions(ss, st, state.data.rowIndex));
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

  // 変更後の内容（変更した項目に「（変更）」付き）を見せて確認する
  _toConfirm(state, userId, replyToken, ss, st) {
    const d = state.data;
    state.step = 'CONFIRM';
    StateManager.set(userId, state);
    const after = Object.assign({}, this._current(ss, state), d.updates);
    const overlap = this._overlap(ss, st, state, after);
    LineApi.reply(replyToken,
      `No.${d.reservationId} ${d.guestName}さんの予約を変更します。\n変更後の内容：\n${Identity.describe(ss, st, after, Object.keys(d.updates))}\n` +
      (overlap ? overlap + '\n' : '') + 'よろしいですか？',
      ['この内容で変更', 'やめる']);
  },

  // 枠か希望対応者を変えた結果、同じ枠・同じ対応者の予約と重なるときの注意文（なければ空文字）
  _overlap(ss, st, state, after) {
    const u = state.data.updates || {};
    if (u.slot === undefined && u.staff === undefined) return '';
    return RegisterFlow._overlapNotice(ss, st, after.slot, after.staff, state.data.rowIndex);
  },

  _save(state, userId, replyToken, ss, st) {
    const d = state.data;
    const before = this._current(ss, state);

    // 枠を変える場合は、確認している間に満席になっていないかを見直す
    if (d.updates.slot !== undefined) {
      const stillOpen = SheetUtils.getAvailableSlots(ss).some(s => Number(s['枠番号']) === Number(d.updates.slot));
      if (!stillOpen) {
        StateManager.clear(userId);
        LineApi.reply(replyToken, '申し訳ありません。その枠は満席になりました。お手数ですが、もう一度「変更」からやり直してください。');
        return;
      }
    }

    const overlap = this._overlap(ss, st, state, Object.assign({}, before, d.updates));
    Object.keys(d.updates).forEach(key => SheetUtils.updateReservationField(ss, d.rowIndex, key, d.updates[key]));
    // 主催者が「確定枠番号」を入れていた場合は、古い枠を指したままにならないよう外す
    if (d.updates.slot !== undefined) SheetUtils.updateReservationField(ss, d.rowIndex, 'confirmedSlot', '');

    // 「要確認」の予約は、変更しても要確認のままにする（満枠の確認が消えないように）
    if (!before || before.status !== STATUS.PENDING) {
      SheetUtils.updateReservationStatus(ss, d.rowIndex, STATUS.CHANGED);
    }

    LineApi.reply(replyToken, '変更しました。' + (overlap ? '\n' + overlap : ''));
    const who = (d.organizerName !== d.guestName)
      ? `${d.organizerName}さんが${d.guestName}さんの予約を` : `${d.guestName}さんが予約を`;
    const labels = Object.keys(d.updates).map(k => st[k].label).join('・');
    let detail = '';
    if (d.updates.slot !== undefined) {
      const slotMap = {};
      SheetUtils.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = SheetUtils.slotLabel(s); });
      const from = (before && before.slot !== '') ? (slotMap[Number(before.slot)] || '枠' + before.slot) : '（枠なし）';
      detail = `\n${st.slot.label}：${from} → ${slotMap[Number(d.updates.slot)]}`;
      if (before && before.confirmedStaff) detail += `\n※${st.staff_role.label}を確定済みでした。確認してください。`;
    }
    if (overlap) detail += '\n⚠同じ枠で同じ希望対応者の予約が重なっています。';
    SheetUtils.notifyOrganizers(`【変更】[${state.eventName}] ${who}変更しました（${labels}）。${detail}`);
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

    const reservations = Identity.mine(ss, name, state.data.selfMode);

    StateManager.clear(userId);

    if (reservations.length === 0) {
      LineApi.reply(replyToken, '登録されている予約が見つかりませんでした。');
      return;
    }

    // 時間枠を使わない開催では枠の表示を省く
    const lines = reservations.map(r => {
      const slotText = (r.slot === '' || r.slot === undefined) ? '' : (slotMap[Number(r.slot)] || '枠' + r.slot);
      return '・' + [`${r.guest}様`, slotText, `ステータス:${r.status === STATUS.PENDING ? '要確認（キャンセル待ち）' : r.status}`].filter(Boolean).join('／');
    });
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
        Identity.showList(state, userId, replyToken, ss, 'キャンセル');
      }
      return;
    }

    switch (state.step) {
      // 本人モード（動員する人OFF）：入力された名前＝予約した人
      case 'ASK_GUEST_NAME':
        state.data.organizerName = text;
        Identity.showList(state, userId, replyToken, ss, 'キャンセル');
        return;

      // 一覧を見て、番号または名前でキャンセルする予約を選ぶ
      case 'PICK_RESERVATION': {
        if (text === 'やめる') {
          StateManager.clear(userId);
          LineApi.reply(replyToken, 'キャンセルを中止しました。');
          return;
        }
        const picked = Identity.pick(state, replyToken, ss, text);
        if (picked.done) return;
        const target = picked.reservation;
        state.data.guestName = target.guest;
        state.data.rowIndex = target.rowIndex;
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken,
          `No.${target.id} ${target.guest}さんの予約をキャンセルします。\n${Identity.describe(ss, st, target)}\nよろしいですか？`,
          ['キャンセルする', 'やめる']);
        return;
      }

      case 'CONFIRM':
        if (text === 'キャンセルする') {
          SheetUtils.updateReservationStatus(ss, state.data.rowIndex, STATUS.CANCELED);
          LineApi.reply(replyToken, 'キャンセルしました。');
          const who = (state.data.organizerName !== state.data.guestName)
            ? `${state.data.organizerName}さんが${state.data.guestName}さんの予約を` : `${state.data.guestName}さんが予約を`;
          // 要確認（キャンセル待ち）の人がいるときは、空きが出た可能性を主催者に知らせる
          const waiting = SheetUtils.getReservations(ss).filter(r => r.status === STATUS.PENDING).length;
          SheetUtils.notifyOrganizers(`【キャンセル】[${state.eventName}] ${who}キャンセルしました。` +
            (waiting > 0 ? `\n※要確認（キャンセル待ち）の予約が${waiting}件あります。` : ''));
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

  // ---------- 予約の一覧と選択（キャンセル・変更で共通）----------

  // この人が登録した予約。キャンセル済みは除く。
  //   動員する人がONの開催：「動員する人」の列で探す
  //   本人モード（動員する人がOFF）：「ゲスト名」の列で探す（動員する人の列は空欄のため）
  mine(ss, name, selfMode) {
    const key = selfMode ? 'guest' : 'organizer';
    return SheetUtils.getReservations(ss)
      .filter(r => String(r[key]).trim() === String(name).trim() && r.status !== STATUS.CANCELED);
  },

  // 一覧の1行：「No.1　小野あかね　受付」（枠があれば名前のあとに付ける）
  line(ss, r) {
    const slotMap = {};
    SheetUtils.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = SheetUtils.slotLabel(s); });
    const slot = (r.slot === '' || r.slot === undefined) ? '' : (slotMap[Number(r.slot)] || '枠' + r.slot);
    return ['No.' + r.id, r.guest, slot, r.status].filter(Boolean).join('　');
  },

  // 予約の一覧を出して、番号または名前を聞く（verb：「キャンセル」「変更」）。step を PICK_RESERVATION にする
  showList(state, userId, replyToken, ss, verb) {
    const name = state.data.organizerName;
    const list = this.mine(ss, name, state.data.selfMode);
    if (list.length === 0) {
      StateManager.clear(userId);
      LineApi.reply(replyToken, `「${name}」さんの${verb}できる予約は見つかりませんでした。名前を確認してもう一度お試しください。`);
      return;
    }
    state.step = 'PICK_RESERVATION';
    StateManager.set(userId, state);
    LineApi.reply(replyToken,
      `「${name}」さんが予約したのは以下です。\n` + list.map(r => this.line(ss, r)).join('\n') +
      `\n${verb}する番号または名前を入力してください。`, ['やめる']);
  },

  // 番号または名前から予約を決める。決まれば { reservation }、決まらなければ返信済みで { done: true }
  pick(state, replyToken, ss, text) {
    const list = this.mine(ss, state.data.organizerName, state.data.selfMode);
    const key = Util.toHalfWidth(text).trim().replace(/^no\.?\s*/i, '');
    let target = null;
    if (/^\d+$/.test(key)) {
      target = list.find(r => String(r.id) === String(Number(key)));
      if (!target) {
        LineApi.reply(replyToken, `No.${key} は一覧にありません。一覧の番号または名前を入力してください。`, ['やめる']);
        return { done: true };
      }
    } else {
      const named = list.filter(r => String(r.guest).trim() === text.trim());
      if (named.length === 0) {
        LineApi.reply(replyToken, `「${text}」は一覧にありません。一覧の番号または名前を入力してください。`, ['やめる']);
        return { done: true };
      }
      if (named.length > 1) {
        LineApi.reply(replyToken,
          `「${text}」さんの予約が複数あります。番号で教えてください。\n` + named.map(r => this.line(ss, r)).join('\n'),
          ['やめる']);
        return { done: true };
      }
      target = named[0];
    }
    return { reservation: target };
  },

  // 登録されている内容を、設定タブでONの項目だけ文章にする（時間枠OFFの開催では枠を出さない）。
  // changedKeys（項目キーの配列）を渡すと、その項目に「（変更）」を付ける
  describe(ss, st, r, changedKeys) {
    const changed = Array.isArray(changedKeys) ? changedKeys : (changedKeys ? [changedKeys] : []);
    const slotMap = {};
    SheetUtils.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = SheetUtils.slotLabel(s); });
    const lines = [];
    const add = (key, value) => {
      if (Settings.isOn(st, key) && value !== '' && value !== undefined && value !== null) {
        lines.push(`・${st[key].label}：${value}` + (changed.indexOf(key) !== -1 ? '（変更）' : ''));
      }
    };
    if (Settings.isOn(st, 'organizer') && String(r.organizer).trim() !== String(r.guest).trim()) add('organizer', r.organizer);
    add('slot', (r.slot === '' || r.slot === undefined) ? '' : (slotMap[Number(r.slot)] || '枠' + r.slot));
    add('age', r.age);
    add('gender', r.gender);
    add('staff', r.staff);
    add('menu', r.menu);
    if (Settings.isOn(st, 'note')) {
      lines.push(`・${st.note.label}：${r.note || 'なし'}` + (changed.indexOf('note') !== -1 ? '（変更）' : ''));
    }
    lines.push(`・ステータス：${r.status === STATUS.PENDING ? '要確認（キャンセル待ち）' : r.status}`);
    return lines.join('\n');
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

  // LINEの表示名（取れなければ空文字）
  getDisplayName(userId) {
    try {
      const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()).displayName || '';
    } catch (e) {
      console.warn('表示名を取得できませんでした: ' + e);
    }
    return '';
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

  // 選んだ枠で対応できる人だけを返す。
  //   対応者一覧のB列（対応可能時間帯）に、枠マスタの「枠名」をカンマ（, 、 ，）区切りで書くと、その枠でだけ選べる。
  //   ・B列が空欄の人／B列に枠名が1つも書かれていない人（「昼のみ」などのメモ）は、どの枠でも選べる
  //   ・slotNumber が空（時間枠を使わない・キャンセル待ち）なら全員を返す
  getStaffForSlot(ss, slotNumber) {
    const all = this.getStaffList(ss);
    if (slotNumber === '' || slotNumber === undefined || slotNumber === null) return all;
    const slots = this.getSlotList(ss);
    const chosen = slots.find(s => Number(s['枠番号']) === Number(slotNumber));
    if (!chosen) return all;
    const norm = v => Util.toHalfWidth(String(v)).trim();
    const slotNames = slots.map(s => norm(s['枠名']));
    const sheet = ss.getSheetByName(SHEET_NAMES.STAFF_LIST);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const width = Math.min(2, sheet.getMaxColumns());
    const rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues()
      .map(r => [r[0], width > 1 ? r[1] : '']);
    return rows
      .filter(r => String(r[0]).trim() !== '')
      .filter(r => {
        const tokens = String(r[1]).split(/[,、，\n]/).map(norm).filter(t => t !== '');
        const known = tokens.filter(t => slotNames.indexOf(t) !== -1);
        if (known.length === 0) return true; // 制限なし
        return known.indexOf(norm(chosen['枠名'])) !== -1;
      })
      .map(r => String(r[0]).trim());
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

  // 枠の受付可能人数。空欄・数字以外は「制限なし」として扱う
  _capacityOf(slot) {
    const raw = Util.toHalfWidth(slot['受付可能人数']).trim();
    if (raw === '') return Infinity;
    const n = Number(raw);
    return isNaN(n) ? Infinity : n;
  },

  // 枠ごとの空き状況。使った人数には「要確認（キャンセル待ち）」も含める
  // （キャンセルが出ても、待っている人より先に新しい人が入らないようにするため）
  getSlotAvailability(ss) {
    const counts = {};
    this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && r.slot !== '' && r.slot !== undefined)
      .forEach(r => { counts[Number(r.slot)] = (counts[Number(r.slot)] || 0) + 1; });
    return this.getSlotList(ss).map(s => {
      const capacity = this._capacityOf(s);
      const used = counts[Number(s['枠番号'])] || 0;
      return { slot: s, capacity: capacity, used: used, remaining: capacity - used };
    });
  },

  // まだ空きがある枠だけ
  getAvailableSlots(ss) {
    return this.getSlotAvailability(ss).filter(a => a.remaining > 0).map(a => a.slot);
  },

  // 時間枠を使わない開催：枠マスタの「受付可能人数」の合計をイベント全体の定員とみなす。
  // 枠マスタが空、または受付可能人数が空欄の行があれば「制限なし」
  isEventFull(ss) {
    const slots = this.getSlotList(ss);
    if (slots.length === 0) return false;
    const capacities = slots.map(s => this._capacityOf(s));
    if (capacities.some(c => c === Infinity)) return false;
    const total = capacities.reduce((a, b) => a + b, 0);
    const used = this.getReservations(ss).filter(r => r.status !== STATUS.CANCELED).length;
    return used >= total;
  },

  // 時間枠を使わない開催：あと何人受け付けられるか。制限なしなら Infinity
  getEventRemaining(ss) {
    const slots = this.getSlotList(ss);
    if (slots.length === 0) return Infinity;
    const capacities = slots.map(s => this._capacityOf(s));
    if (capacities.some(c => c === Infinity)) return Infinity;
    const total = capacities.reduce((a, b) => a + b, 0);
    const used = this.getReservations(ss).filter(r => r.status !== STATUS.CANCELED).length;
    return total - used;
  },

  // 同じ枠・同じ希望対応者で、すでにある予約の件数（キャンセルと excludeRowIndex の行は除く）
  countSameStaff(ss, slotNumber, staff, excludeRowIndex) {
    if (slotNumber === '' || slotNumber === undefined || slotNumber === null) return 0;
    if (staff === '' || staff === undefined || staff === null) return 0;
    return this.getReservations(ss).filter(r =>
      r.status !== STATUS.CANCELED && r.rowIndex !== excludeRowIndex &&
      r.slot !== '' && Number(r.slot) === Number(slotNumber) &&
      String(r.staff).trim() === String(staff).trim()).length;
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

    // 受付か要確認（キャンセル待ち）かを決める
    //   ・data.waitlist        : 満席と分かっている（空いている枠がない）→ 要確認
    //   ・data.slotOff         : 時間枠を使わない開催 → イベント全体の定員で判定
    //   ・それ以外             : 選んだ枠の定員で判定（登録の瞬間にもう一度確認する）
    const hasSlot = !data.slotOff && !data.waitlist &&
      data.slotNumber !== undefined && data.slotNumber !== '' && data.slotNumber !== null;
    let status = STATUS.ACCEPTED;
    if (data.waitlist) {
      status = STATUS.PENDING;
    } else if (data.slotOff) {
      if (this.isEventFull(ss)) status = STATUS.PENDING;
    } else {
      const slot = this.getSlotList(ss).find(s => Number(s['枠番号']) === Number(data.slotNumber));
      if (!slot) {
        status = STATUS.PENDING;
      } else {
        const currentCount = this.countReservationsInSlot(ss, data.slotNumber);
        status = (currentCount + 1) > this._capacityOf(slot) ? STATUS.PENDING : STATUS.ACCEPTED;
      }
    }

    sheet.getRange(targetRow, 1, 1, RES_DATA_COLS).setValues([[
      newId,
      hasSlot ? data.slotNumber : '',
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
      ; // 予約の全項目（rowIndex・status を含む）をそのまま返す
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

    // 時間枠を使わない開催は、枠×対応者の表を作れないので、参加者の一覧（名簿）にする
    if (!Settings.isOn(st, 'slot')) return this._buildGuestList(ss, st, sheet);

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

  // 時間枠を使わない開催用：キャンセル以外の予約を、動員する人ごとの名簿にする。戻り値は常に0（重複の概念がない）
  _buildGuestList(ss, st, sheet) {
    const cols = []; // [見出し, 取り出し方]
    if (Settings.isOn(st, 'organizer')) cols.push([st.organizer.label, r => r.organizer]);
    cols.push([st.guest.label, r => r.guest]);
    if (Settings.isOn(st, 'age')) cols.push([st.age.label, r => r.age]);
    if (Settings.isOn(st, 'gender')) cols.push([st.gender.label, r => r.gender]);
    if (Settings.isOn(st, 'staff')) cols.push([st.staff.label, r => r.staff]);
    if (Settings.isOn(st, 'menu')) cols.push([st.menu.label, r => r.menu]);
    if (Settings.isOn(st, 'note')) cols.push([st.note.label, r => r.note]);
    if (Settings.isOn(st, 'staff')) cols.push(['確定' + st.staff_role.label, r => r.confirmedStaff]);
    cols.push(['ステータス', r => r.status]);

    sheet.getRange(1, 1, 1, cols.length).setValues([cols.map(c => c[0])])
      .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    for (let i = 0; i < cols.length; i++) sheet.setColumnWidth(1 + i, 160);

    const rows = this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED)
      .sort((a, b) => String(a.organizer).localeCompare(String(b.organizer), 'ja') || Number(a.id) - Number(b.id))
      .map(r => cols.map(c => c[1](r)));
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, cols.length).setValues(rows).setWrap(true).setVerticalAlignment('top');
    }
    return 0;
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
      .map(r => [r.id, slotMap[Number(r.slot)] || r.slot || '（枠なし）', r.organizer, r.guest, r.staff, r.createdAt, r.memo]);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
    return rows.length;
  },

  // ---------- 通知 ----------

  // 親シート「主催者通知先」の「合言葉」列（2行目）。空欄なら LINEからの自動登録は使えない
  getNotifyPasscode() {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.NOTIFY_LIST);
    const rows = sheet.getDataRange().getValues();
    const i = rows[0].indexOf('合言葉');
    if (i < 0 || rows.length < 2) return '';
    return String(rows[1][i] === undefined || rows[1][i] === null ? '' : rows[1][i]).trim();
  },

  // LINEからの通知先登録・解除。戻り値：'added'（新規追加）/ 'on'（ONにした）/ 'off'（OFFにした）/ 'none'（登録なし）
  setNotifyUser(userId, name, on) {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.NOTIFY_LIST);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    const iName = header.indexOf('主催者名');
    const iId = header.indexOf('LINE User ID');
    const iOnOff = header.indexOf('通知ON/OFF');
    let found = -1;
    let firstBlank = -1;
    for (let i = 1; i < rows.length; i++) {
      const id = String(rows[i][iId] === undefined ? '' : rows[i][iId]).trim();
      if (id === userId) { found = i; break; }
      if (id === '' && firstBlank === -1) firstBlank = i;
    }
    if (found !== -1) {
      sheet.getRange(found + 1, iOnOff + 1).setValue(on ? 'ON' : 'OFF');
      return on ? 'on' : 'off';
    }
    if (!on) return 'none';
    const row = (firstBlank !== -1 ? firstBlank : rows.length) + 1;
    if (iName >= 0) sheet.getRange(row, iName + 1).setValue(name);
    sheet.getRange(row, iId + 1).setValue(userId);
    sheet.getRange(row, iOnOff + 1).setValue('ON');
    return 'added';
  },

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
  // 全角の数字・英字を半角に（「１」「ＯＦＦ」と入力されても読めるように）
  toHalfWidth(s) {
    return String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
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

// ===== AvailFlow.gs =====
// 「空き枠確認」フロー：選んだ開催の空き状況を1通で返す（質問はしない）

const AvailFlow = {
  start(userId, replyToken, event) {
    const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
    const st = Settings.load(ss);
    const allowFull = Settings.isOn(st, 'waitlist');
    const lines = [`「${event.name}」の空き状況です。`];
    let anyFull = false;

    if (Settings.isOn(st, 'slot')) {
      const list = SheetUtils.getSlotAvailability(ss);
      if (list.length === 0) {
        LineApi.reply(replyToken, `「${event.name}」には、現在選べる${st.slot.label}がありません。主催者にご確認ください。`);
        return;
      }
      list.forEach(a => {
        let status;
        if (a.capacity === Infinity) status = '空きあり';
        else if (a.remaining > 0) status = `残り${a.remaining}名`;
        else { status = '満席'; anyFull = true; }
        lines.push(`・${SheetUtils.slotLabel(a.slot)}　${status}`);
      });
    } else {
      const remaining = SheetUtils.getEventRemaining(ss);
      if (remaining === Infinity) lines.push('・空きあり');
      else if (remaining > 0) lines.push(`・残り${remaining}名`);
      else { lines.push('・満席'); anyFull = true; }
    }

    if (anyFull) {
      lines.push('', allowFull
        ? '※満席の枠は、キャンセル待ち（要確認）として受け付けています。'
        : '※満席の枠は、受付できません。');
    }
    lines.push('', 'お申し込みは「登録」と送ってください。');
    LineApi.reply(replyToken, lines.join('\n'));
  },
};
