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

  // 開催ID（開催年月日_開催名）の組み立て
  makeEventId(parsedDate, name) {
    return `${parsedDate.yyyymmdd}_${name}`;
  },

  // その開催IDが、すでに開催マスタにあるか（予約シートURLが空の行も含めて調べる）
  eventIdExists(eventId) {
    const master = SheetUtils.getControlSheet().getSheetByName(SHEET_NAMES.EVENT_MASTER);
    const idColumn = master.getRange(1, 1, master.getMaxRows(), 1).getValues().flat();
    return SheetUtils.getAllEvents().some(e => e.eventId === eventId) || idColumn.indexOf(eventId) !== -1;
  },

  // ひな形を複製して「開催年月日_開催名」のファイルを作り、開催マスタに追記する
  createEvent(parsedDate, name, template) {
    const eventId = this.makeEventId(parsedDate, name);
    const control = SheetUtils.getControlSheet();
    const master = control.getSheetByName(SHEET_NAMES.EVENT_MASTER);

    const idColumn = master.getRange(1, 1, master.getMaxRows(), 1).getValues().flat();
    if (this.eventIdExists(eventId)) {
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
