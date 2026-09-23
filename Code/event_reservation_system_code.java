// ===== Config.gs =====
// 実際の値はスクリプトエディタの「プロジェクトの設定」→「スクリプト プロパティ」で設定してください。
//   CONTROL_SHEET_ID          : 親（コントロール）シートのスプレッドシートID
//   LINE_CHANNEL_ACCESS_TOKEN : LINE Developersで発行したチャネルアクセストークン
 
const CONFIG = {
  CONTROL_SHEET_ID: PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID'),
  LINE_CHANNEL_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
};
 
// 親シート・開催別シートで使うタブ名（xlsxひな形と一致させています）
const SHEET_NAMES = {
  EVENT_MASTER: '開催マスタ',
  NOTIFY_LIST: '主催者通知先',
  STAFF_LIST: '対応者一覧',
  SLOT_MASTER: '枠マスタ',
  TREATMENT_MENU: '施術メニュー',
  RESERVATIONS: '予約',
};
 
// 会話状態（CacheService）の保持時間。この時間操作がないと最初からやり直しになる
const STATE_CACHE_SECONDS = 1800; // 30分

// ===== Main.gs =====
// LINEからのWebhookを受け取る入口。
// Webアプリとしてデプロイし、そのURLをLINE DevelopersのWebhook URLに設定してください。
 
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];
    events.forEach(handleEvent);
  } catch (err) {
    console.error('doPost error: ' + err);
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
 
function startFlow(flow, userId, replyToken) {
  switch (flow) {
    case 'register': return RegisterFlow.start(userId, replyToken);
    case 'cancel': return CancelFlow.start(userId, replyToken);
    case 'confirm': return ConfirmFlow.start(userId, replyToken);
    case 'change': return ChangeFlow.start(userId, replyToken);
  }
}
 
function routeToFlow(state, userId, replyToken, text) {
  switch (state.flow) {
    case 'register': return RegisterFlow.handle(state, userId, replyToken, text);
    case 'cancel': return CancelFlow.handle(state, userId, replyToken, text);
    case 'confirm': return ConfirmFlow.handle(state, userId, replyToken, text);
    case 'change': return ChangeFlow.handle(state, userId, replyToken, text);
    default:
      StateManager.clear(userId);
      LineApi.reply(replyToken, 'エラーが発生しました。もう一度メニューから選び直してください。');
  }
}
 
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
 
// ===== LineApi.gs =====
// LINE Messaging APIへの返信（reply）とプッシュ通知（push）をまとめたヘルパー。
 
const LineApi = {
  // choices を渡すとクイックリプライ（タップで同じ文言を送信）が付く
  reply(replyToken, text, choices) {
    const message = { type: 'text', text: text };
    if (choices && choices.length > 0) {
      message.quickReply = { items: choices.map(this._quickReplyItem) };
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

  // 「募集中」の開催を1件取得する（同時に複数募集中にはならない前提）
  getActiveEvent() {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.EVENT_MASTER);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    const idxId = header.indexOf('開催ID');
    const idxUrl = header.indexOf('予約シートURL');
    const idxStatus = header.indexOf('ステータス');

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][idxStatus] === '募集中') {
        return { eventId: rows[i][idxId], spreadsheetUrl: rows[i][idxUrl] };
      }
    }
    return null;
  },

  openReservationSpreadsheet(url) {
    return SpreadsheetApp.openById(this.extractSpreadsheetId(url));
  },

  extractSpreadsheetId(url) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('スプレッドシートURLからIDを取得できません: ' + url);
    return m[1];
  },

  // シートを「1行目=見出し」の連想配列の配列として読み込む共通処理
  _readTable(ss, sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    return rows.slice(1)
      .filter(r => r.some(v => v !== ''))
      .map(r => {
        const obj = {};
        header.forEach((h, i) => obj[h] = r[i]);
        return obj;
      });
  },

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
      });
  },

  getStaffList(ss) {
    return this._readTable(ss, SHEET_NAMES.STAFF_LIST);
  },

  getTreatmentMenu(ss) {
    return this._readTable(ss, SHEET_NAMES.TREATMENT_MENU).map(r => r['施術名']);
  },

  getReservations(ss) {
    return this._readTable(ss, SHEET_NAMES.RESERVATIONS);
  },

  // 指定した枠番号の現在の受付件数（キャンセルを除く）
  countReservationsInSlot(ss, slotNumber) {
    return this.getReservations(ss)
      .filter(r => Number(r['枠番号']) === Number(slotNumber) && r['ステータス'] !== 'キャンセル')
      .length;
  },

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
    const status = (currentCount + 1) > capacity ? '要確認' : '受付';

    sheet.getRange(targetRow, 1, 1, 14).setValues([[
      newId,
      data.slotNumber,
      data.organizerName,
      data.guestName,
      data.age,
      data.gender,
      data.staff,
      data.treatments.join('、'),
      data.note || '',
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
      status,
      '', // 確定担当者（前日ミーティングで記入）
      '', // 確定枠番号（同上）
      '', // 主催者メモ
    ]]);

    // 枠表示（O列）・重複チェック（P列）は数式で自動計算されるようにする
    // 「$B列が空欄でない」条件を加えて、空欄行同士が誤って重複判定されないようにしている
    sheet.getRange(targetRow, 15).setFormula(
      `=IFERROR(VLOOKUP($B${targetRow},枠マスタ!$A:$E,2,FALSE)&"("&TEXT(VLOOKUP($B${targetRow},枠マスタ!$A:$E,3,FALSE),"HH:mm")&")","")`
    );
    sheet.getRange(targetRow, 16).setFormula(
      `=IF(AND($B${targetRow}<>"",COUNTIFS($B$2:$B,$B${targetRow},$G$2:$G,$G${targetRow},$K$2:$K,"<>キャンセル")>1),"⚠重複あり","")`
    );

    return { reservationId: newId, status: status };
  },

  // 動員する人の名前＋ゲスト名で予約を検索（キャンセル済みは除く）
  findReservation(ss, organizerName, guestName) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    const idx = {};
    header.forEach((h, i) => idx[h] = i);

    const matches = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row[idx['動員する人']] === organizerName &&
          row[idx['ゲスト名']] === guestName &&
          row[idx['ステータス']] !== 'キャンセル') {
        matches.push({ rowIndex: r + 1 }); // シート上の実際の行番号（1始まり、見出し込み）
      }
    }
    return matches;
  },

  updateReservationStatus(ss, rowIndex, status) {
    this.updateReservationField(ss, rowIndex, 'ステータス', status);
  },

  updateReservationField(ss, rowIndex, fieldName, value) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = header.indexOf(fieldName) + 1;
    if (col === 0) throw new Error('列が見つかりません: ' + fieldName);
    sheet.getRange(rowIndex, col).setValue(value);
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

// ===== RegisterFlow.gs =====
// 「登録」フロー：動員者名(初回のみ)→ゲスト名→時間枠→年齢→性別→希望対応者→施術(複数可)→伝達事項→確認→保存

const RegisterFlow = {
  start(userId, replyToken) {
    const activeEvent = SheetUtils.getActiveEvent();
    if (!activeEvent) {
      LineApi.reply(replyToken, '現在募集中の開催がありません。主催者にご確認ください。');
      return;
    }

    const state = {
      flow: 'register',
      step: null,
      spreadsheetUrl: activeEvent.spreadsheetUrl,
      data: {},
    };

    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken,
        `前回「${lastName}」として登録されていますが、今回も同じ名前でよいですか？`,
        ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      state.step = 'ASK_ORGANIZER_NAME';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, 'まず、あなた（動員する人）のお名前を教えてください。');
    }
  },

  handle(state, userId, replyToken, text) {
    switch (state.step) {
      case 'CONFIRM_ORGANIZER_NAME':
        if (text === 'はい') {
          state.data.organizerName = state.data.organizerNameCandidate;
          this._toAskGuestName(state, userId, replyToken);
        } else {
          state.step = 'ASK_ORGANIZER_NAME';
          StateManager.set(userId, state);
          LineApi.reply(replyToken, 'お名前を入力してください。');
        }
        return;

      case 'ASK_ORGANIZER_NAME':
        state.data.organizerName = text;
        StateManager.setLastOrganizerName(userId, text);
        this._toAskGuestName(state, userId, replyToken);
        return;

      case 'ASK_GUEST_NAME':
        state.data.guestName = text;
        this._toAskSlot(state, userId, replyToken);
        return;

      case 'ASK_SLOT': {
        const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
        const slots = SheetUtils.getSlotList(ss);
        const slot = slots.find(s => this._slotLabel(s) === text);
        if (!slot) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', slots.map(s => this._slotLabel(s)));
          return;
        }
        state.data.slotNumber = slot['枠番号'];
        state.step = 'ASK_AGE';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, 'ゲストの年齢（おおよそ）を教えてください。',
          ['10代', '20代', '30代', '40代', '50代以上']);
        return;
      }

      case 'ASK_AGE':
        state.data.age = text;
        state.step = 'ASK_GENDER';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '性別を教えてください。', ['女性', '男性', '回答しない']);
        return;

      case 'ASK_GENDER': {
        state.data.gender = text;
        const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
        const staffList = SheetUtils.getStaffList(ss).map(s => s['対応者名']);
        staffList.push('誰でも良い');
        state.step = 'ASK_STAFF';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '希望する対応者はいますか？', staffList);
        return;
      }

      case 'ASK_STAFF': {
        state.data.staff = text;
        const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
        const menu = SheetUtils.getTreatmentMenu(ss);
        state.data.treatments = [];
        state.data.remainingTreatments = menu;
        state.step = 'ASK_TREATMENT';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, 'やって欲しい施術を選んでください（複数選択できます）。',
          [...menu, '選び終わった']);
        return;
      }

      case 'ASK_TREATMENT':
        this._handleTreatmentSelection(state, userId, replyToken, text, 'ASK_NOTE',
          () => LineApi.reply(replyToken,
            '伝えておきたいことがあれば教えてください（アレルギーなど）。', ['特になし']));
        return;

      case 'ASK_NOTE':
        state.data.note = (text === '特になし') ? '' : text;
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, this._buildConfirmText(state.data), ['この内容で登録', 'やり直す']);
        return;

      case 'CONFIRM':
        if (text === 'この内容で登録') {
          this._save(state, userId, replyToken);
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

  // 施術の複数選択（登録・変更フロー共通で使う）
  _handleTreatmentSelection(state, userId, replyToken, text, nextStep, onDone) {
    if (text === '選び終わった') {
      if (state.data.treatments.length === 0) {
        LineApi.reply(replyToken, '1つ以上選んでください。', [...state.data.remainingTreatments, '選び終わった']);
        return;
      }
      state.step = nextStep;
      StateManager.set(userId, state);
      onDone();
      return;
    }
    if (!state.data.remainingTreatments.includes(text)) {
      LineApi.reply(replyToken, '選択肢の中から選んでください。', [...state.data.remainingTreatments, '選び終わった']);
      return;
    }
    state.data.treatments.push(text);
    state.data.remainingTreatments = state.data.remainingTreatments.filter(t => t !== text);
    StateManager.set(userId, state);
    LineApi.reply(replyToken, `「${text}」を選びました。他にもありますか？`,
      [...state.data.remainingTreatments, '選び終わった']);
  },

  _toAskGuestName(state, userId, replyToken) {
    state.step = 'ASK_GUEST_NAME';
    StateManager.set(userId, state);
    LineApi.reply(replyToken, 'ゲストのお名前を教えてください。');
  },

  _toAskSlot(state, userId, replyToken) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const slots = SheetUtils.getSlotList(ss);
    state.step = 'ASK_SLOT';
    StateManager.set(userId, state);
    LineApi.reply(replyToken, 'ご希望の時間枠を選んでください。', slots.map(s => this._slotLabel(s)));
  },

  _slotLabel(slot) {
    const time = slot['開始時刻'];
    // スプレッドシート側で時刻形式に入力されているとDateオブジェクトとして渡ってくるため、
    // その場合はHH:mm形式の文字列に変換する（文字列で入っている場合はそのまま使う）
    const timeStr = (time instanceof Date)
      ? Utilities.formatDate(time, 'Asia/Tokyo', 'HH:mm')
      : time;
    return `${slot['枠名']}(${timeStr})`;
  },

  _buildConfirmText(data) {
    return [
      '以下の内容で登録します。よろしいですか？',
      `ゲスト名：${data.guestName}`,
      `年齢：${data.age}／性別：${data.gender}`,
      `希望対応者：${data.staff}`,
      `施術：${data.treatments.join('、')}`,
      `伝達事項：${data.note || 'なし'}`,
    ].join('\n');
  },

  _save(state, userId, replyToken) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const result = SheetUtils.appendReservation(ss, state.data);
    StateManager.clear(userId);

    const guestMsg = (result.status === '受付')
      ? `受け付けました（予約No.${result.reservationId}）。`
      : `現在満枠のため「要確認」として登録しました（予約No.${result.reservationId}）。主催者確認後、あらためてご連絡します。`;
    LineApi.reply(replyToken, guestMsg);

    SheetUtils.notifyOrganizers(
      `【新規登録】${state.data.organizerName}さんが${state.data.guestName}さんを登録しました` +
      `（枠:${state.data.slotNumber} / ステータス:${result.status}）`
    );
  },
};

// ===== CancelFlow.gs =====
// 「キャンセル」フロー：動員者名→ゲスト名→確認→ステータス更新

const CancelFlow = {
  start(userId, replyToken) {
    const activeEvent = SheetUtils.getActiveEvent();
    if (!activeEvent) {
      LineApi.reply(replyToken, '現在募集中の開催がありません。');
      return;
    }
    const state = {
      flow: 'cancel',
      step: 'ASK_ORGANIZER_NAME',
      spreadsheetUrl: activeEvent.spreadsheetUrl,
      data: {},
    };
 
    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `「${lastName}」さんの予約から探しますか？`,
        ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      StateManager.set(userId, state);
      LineApi.reply(replyToken, 'あなた（動員する人）のお名前を教えてください。');
    }
  },
 
  handle(state, userId, replyToken, text) {
    switch (state.step) {
      case 'CONFIRM_ORGANIZER_NAME':
        if (text === 'はい') {
          state.data.organizerName = state.data.organizerNameCandidate;
        } else {
          state.step = 'ASK_ORGANIZER_NAME';
          StateManager.set(userId, state);
          LineApi.reply(replyToken, 'お名前を入力してください。');
          return;
        }
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, 'キャンセルするゲストのお名前を教えてください。');
        return;
 
      case 'ASK_ORGANIZER_NAME':
        state.data.organizerName = text;
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, 'キャンセルするゲストのお名前を教えてください。');
        return;
 
      case 'ASK_GUEST_NAME': {
        const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
        const matches = SheetUtils.findReservation(ss, state.data.organizerName, text);
        if (matches.length === 0) {
          LineApi.reply(replyToken, '該当する予約が見つかりませんでした。名前を確認してもう一度お試しください。');
          StateManager.clear(userId);
          return;
        }
        state.data.guestName = text;
        state.data.rowIndex = matches[0].rowIndex; // スタッフ名+ゲスト名で一意に決まる前提
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `${text}さんの予約をキャンセルします。よろしいですか？`,
          ['キャンセルする', 'やめる']);
        return;
      }
 
      case 'CONFIRM':
        if (text === 'キャンセルする') {
          const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
          SheetUtils.updateReservationStatus(ss, state.data.rowIndex, 'キャンセル');
          LineApi.reply(replyToken, 'キャンセルしました。');
          SheetUtils.notifyOrganizers(
            `【キャンセル】${state.data.organizerName}さんが${state.data.guestName}さんの予約をキャンセルしました。`);
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

// ===== ConfirmFlow.gs =====
// 「登録確認」フロー：動員者名→本人の予約一覧を返信

const ConfirmFlow = {
  start(userId, replyToken) {
    const activeEvent = SheetUtils.getActiveEvent();
    if (!activeEvent) {
      LineApi.reply(replyToken, '現在募集中の開催がありません。');
      return;
    }
    const state = {
      flow: 'confirm',
      step: 'ASK_ORGANIZER_NAME',
      spreadsheetUrl: activeEvent.spreadsheetUrl,
      data: {},
    };
 
    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `「${lastName}」さんの予約一覧を表示しますか？`,
        ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      StateManager.set(userId, state);
      LineApi.reply(replyToken, 'あなた（動員する人）のお名前を教えてください。');
    }
  },
 
  handle(state, userId, replyToken, text) {
    let organizerName;
 
    if (state.step === 'CONFIRM_ORGANIZER_NAME') {
      if (text === 'はい') {
        organizerName = state.data.organizerNameCandidate;
      } else {
        state.step = 'ASK_ORGANIZER_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, 'お名前を入力してください。');
        return;
      }
    } else if (state.step === 'ASK_ORGANIZER_NAME') {
      organizerName = text;
    } else {
      StateManager.clear(userId);
      return;
    }
 
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const reservations = SheetUtils.getReservations(ss)
      .filter(r => r['動員する人'] === organizerName && r['ステータス'] !== 'キャンセル');
 
    StateManager.clear(userId);
 
    if (reservations.length === 0) {
      LineApi.reply(replyToken, '登録されている予約が見つかりませんでした。');
      return;
    }
 
    const lines = reservations.map(r =>
      `・${r['ゲスト名']}様／枠${r['枠番号']}／ステータス:${r['ステータス']}`);
    LineApi.reply(replyToken, `${organizerName}さんの予約一覧です。\n` + lines.join('\n'));
  },
};

// ===== ChangeFlow.gs =====
// 「変更」フロー：対応者・施術・年齢性別・伝達事項のみ変更可能。
// ゲスト名・時間枠を変えたい場合は、キャンセル→登録し直しの運用とする（合意済み）。

const ChangeFlow = {
  start(userId, replyToken) {
    const activeEvent = SheetUtils.getActiveEvent();
    if (!activeEvent) {
      LineApi.reply(replyToken, '現在募集中の開催がありません。');
      return;
    }
    const state = {
      flow: 'change',
      step: 'ASK_ORGANIZER_NAME',
      spreadsheetUrl: activeEvent.spreadsheetUrl,
      data: {},
    };
 
    const lastName = StateManager.getLastOrganizerName(userId);
    if (lastName) {
      state.step = 'CONFIRM_ORGANIZER_NAME';
      state.data.organizerNameCandidate = lastName;
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `「${lastName}」さんの予約から探しますか？`,
        ['はい', 'いいえ（別の名前を入力する）']);
    } else {
      StateManager.set(userId, state);
      LineApi.reply(replyToken, 'あなた（動員する人）のお名前を教えてください。');
    }
  },

  handle(state, userId, replyToken, text) {
    switch (state.step) {
      case 'CONFIRM_ORGANIZER_NAME':
        if (text === 'はい') {
          state.data.organizerName = state.data.organizerNameCandidate;
        } else {
          state.step = 'ASK_ORGANIZER_NAME';
          StateManager.set(userId, state);
          LineApi.reply(replyToken, 'お名前を入力してください。');
          return;
        }
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '変更するゲストのお名前を教えてください。');
        return;
 
      case 'ASK_ORGANIZER_NAME':
        state.data.organizerName = text;
        state.step = 'ASK_GUEST_NAME';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '変更するゲストのお名前を教えてください。');
        return;
 
      case 'ASK_GUEST_NAME': {
        const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
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
        LineApi.reply(replyToken, '何を変更しますか？',
          ['希望する対応者', '施術', '年齢・性別', '伝達事項']);
        return;
      }
 
      case 'ASK_TARGET':
        state.data.target = text;
        this._askNewValue(state, userId, replyToken);
        return;
 
      case 'INPUT_NEW_VALUE_STAFF':
        state.data.newValue = text;
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `希望する対応者を「${text}」に変更します。よろしいですか？`,
          ['この内容で変更', 'やめる']);
        return;
 
      case 'INPUT_NEW_VALUE_TREATMENT':
        RegisterFlow._handleTreatmentSelection(
          state, userId, replyToken, text, 'CONFIRM',
          () => this._afterTreatmentSelected(state, userId, replyToken)
        );
        return;
 
      case 'INPUT_NEW_VALUE_AGE':
        state.data.newAge = text;
        state.step = 'INPUT_NEW_VALUE_GENDER';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, '性別を選んでください。', ['女性', '男性', '回答しない']);
        return;
 
      case 'INPUT_NEW_VALUE_GENDER':
        state.data.newGender = text;
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `年齢:${state.data.newAge}／性別:${text} に変更します。よろしいですか？`,
          ['この内容で変更', 'やめる']);
        return;
 
      case 'INPUT_NEW_VALUE_NOTE':
        state.data.newValue = (text === '特になし') ? '' : text;
        state.step = 'CONFIRM';
        StateManager.set(userId, state);
        LineApi.reply(replyToken, `伝達事項を「${text}」に変更します。よろしいですか？`,
          ['この内容で変更', 'やめる']);
        return;
 
      case 'CONFIRM':
        if (text === 'この内容で変更') {
          this._save(state, userId, replyToken);
        } else {
          LineApi.reply(replyToken, '変更を中止しました。');
          StateManager.clear(userId);
        }
        return;
 
      default:
        StateManager.clear(userId);
    }
  },

  _askNewValue(state, userId, replyToken) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
 
    if (state.data.target === '希望する対応者') {
      const staffList = SheetUtils.getStaffList(ss).map(s => s['対応者名']);
      staffList.push('誰でも良い');
      state.step = 'INPUT_NEW_VALUE_STAFF';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, '新しい希望対応者を選んでください。', staffList);
    } else if (state.data.target === '施術') {
      const menu = SheetUtils.getTreatmentMenu(ss);
      state.data.treatments = [];
      state.data.remainingTreatments = menu;
      state.step = 'INPUT_NEW_VALUE_TREATMENT';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, '新しい施術を選んでください（複数選択できます）。',
        [...menu, '選び終わった']);
    } else if (state.data.target === '年齢・性別') {
      state.step = 'INPUT_NEW_VALUE_AGE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, '新しい年齢（おおよそ）を選んでください。',
        ['10代', '20代', '30代', '40代', '50代以上']);
    } else if (state.data.target === '伝達事項') {
      state.step = 'INPUT_NEW_VALUE_NOTE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, '新しい伝達事項を入力してください。', ['特になし']);
    }
  },

  _afterTreatmentSelected(state, userId, replyToken) {
    state.data.newValue = state.data.treatments.join('、');
    state.step = 'CONFIRM';
    StateManager.set(userId, state);
    LineApi.reply(replyToken, `施術を「${state.data.newValue}」に変更します。よろしいですか？`,
      ['この内容で変更', 'やめる']);
  },

  _save(state, userId, replyToken) {
    const ss = SheetUtils.openReservationSpreadsheet(state.spreadsheetUrl);
    const fieldMap = {
      '希望する対応者': '希望する対応者',
      '施術': '希望する施術',
      '伝達事項': '伝えておきたいこと',
    };
 
    if (state.data.target === '年齢・性別') {
      SheetUtils.updateReservationField(ss, state.data.rowIndex, '年齢(おおよそ)', state.data.newAge);
      SheetUtils.updateReservationField(ss, state.data.rowIndex, '性別', state.data.newGender);
    } else {
      SheetUtils.updateReservationField(ss, state.data.rowIndex, fieldMap[state.data.target], state.data.newValue);
    }
    SheetUtils.updateReservationStatus(ss, state.data.rowIndex, '変更済');
 
    LineApi.reply(replyToken, '変更しました。');
    SheetUtils.notifyOrganizers(
      `【変更】${state.data.organizerName}さんが${state.data.guestName}さんの予約を変更しました（${state.data.target}）。`);
    StateManager.clear(userId);
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
    console.error('doPost error: ' + err);
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

function startFlow(flow, userId, replyToken) {
  switch (flow) {
    case 'register': return RegisterFlow.start(userId, replyToken);
    case 'cancel': return CancelFlow.start(userId, replyToken);
    case 'confirm': return ConfirmFlow.start(userId, replyToken);
    case 'change': return ChangeFlow.start(userId, replyToken);
  }
}

function routeToFlow(state, userId, replyToken, text) {
  switch (state.flow) {
    case 'register': return RegisterFlow.handle(state, userId, replyToken, text);
    case 'cancel': return CancelFlow.handle(state, userId, replyToken, text);
    case 'confirm': return ConfirmFlow.handle(state, userId, replyToken, text);
    case 'change': return ChangeFlow.handle(state, userId, replyToken, text);
    default:
      StateManager.clear(userId);
      LineApi.reply(replyToken, 'エラーが発生しました。もう一度メニューから選び直してください。');
  }
}

