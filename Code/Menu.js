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

  // 日付と開催名が決まった時点で、同じ開催IDがないかを確かめる（ひな形を選ぶ前に止める）
  const newId = EventAdmin.makeEventId(parsed, name);
  if (EventAdmin.eventIdExists(newId)) {
    ui.alert(`開催ID「${newId}」はすでに開催マスタにあります。\n開催日か開催名を変えて、最初からやり直してください。`);
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
  const event = EventAdmin.pickEvent_('更新する開催を選んでください', ['募集中', '締切']);
  if (!event) return;

  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  // 空欄の確定担当者・確定枠番号を、希望の内容から自動で埋めてから、スケジュールを作る
  const auto = SheetUtils.autoConfirm(ss);
  const duplicateCount = SheetUtils.buildDaySchedule(ss, auto.undecided);
  const pendingCount = SheetUtils.buildPendingList(ss);

  const lines = [`「${event.name}」を更新しました。`];
  if (!Settings.isOn(Settings.load(ss), 'slot')) {
    lines.push('時間枠を使わない開催なので、当日スケジュールは参加者の一覧（名簿）として作成しました。');
  } else {
    lines.push(duplicateCount > 0
      ? `同じ対応者に複数ゲストが割り当てられているセルが ${duplicateCount} 件あります（オレンジ色のセル）。`
      : '当日スケジュールに重複はありません。');
  }
  const role = Settings.load(ss).staff_role.label;
  if (auto.slots > 0 || auto.staff > 0) {
    lines.push(`自動で確定しました：確定枠番号 ${auto.slots} 件／確定${role} ${auto.staff} 件`);
  }
  if (auto.undecided.length > 0) {
    lines.push('', `確定${role}が「未決定」の予約が ${auto.undecided.length} 件あります（当日スケジュールには出ていません）。`);
    auto.undecided.forEach(u => {
      const why = u.reason === 'any' ? '希望なし（誰でも良い）'
        : u.reason === 'ineligible' ? `希望の「${u.wish}」はこの枠に対応できません`
        : `希望の「${u.wish}」は、同じ枠で別の予約に割り当て済みです`;
      lines.push(`・${u.guest}さん（${u.slotLabel}）：${why}`);
    });
    lines.push('', `予約タブの「確定${role}」に手で入力すると、次の更新から反映されます。`, '（この一覧は、当日スケジュールの表の下にも出ています）', '');
  }
  // 担当者が対応できない枠に入っている予約があれば、一覧で知らせる
  const unavailable = SheetUtils.getUnavailableAssignments(ss);
  if (unavailable.length > 0) {
    lines.push('', '⚠担当者が対応できない枠に、スケジュールされています。（赤色のセル）');
    unavailable.forEach(u => lines.push(`・（${u.staff}→${u.slotLabel}）${u.guest}さん`));
    lines.push('', '予約タブの「確定担当者」「確定枠番号」を見直してください。', '');
  }
  // 確定担当者が入っているのに、当日スケジュールに表示されない予約（名前や枠番号の入力ミスなど）
  const hidden = SheetUtils.getUnschedulable(ss);
  if (hidden.length > 0) {
    lines.push('', '⚠次の予約は、当日スケジュールに表示されていません。');
    hidden.forEach(h => {
      const why = h.reason === 'staff' ? `「${h.staff}」は対応者一覧にない名前です`
        : h.reason === 'slot' ? `確定枠番号「${h.slotNumber}」が枠マスタにありません`
        : '枠が決まっていません（確定枠番号を入力してください）';
      lines.push(`・${h.guest}さん：${why}`);
    });
    lines.push('', '予約タブの「確定担当者」「確定枠番号」を見直してください。', '');
  }
  lines.push(`要確認の予約：${pendingCount} 件`);
  ui.alert(lines.join('\n'));
}

// ---------- 予約タブの見出しを設定に合わせる ----------
function menu_applyHeaders() {
  const ui = SpreadsheetApp.getUi();
  const event = EventAdmin.pickEvent_('見出しを更新する開催を選んでください', null, ['終了']);
  if (!event) return;

  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  Settings.applyHeaders(ss, Settings.load(ss));
  ui.alert(`「${event.name}」の予約タブの見出しを、設定タブの表示名に合わせました。`);
}

// ---------- 設定の読み込みを確認 ----------
// LINEのBotが「どのファイルの設定タブを、どう読んでいるか」を表示する
function menu_checkSettings() {
  const ui = SpreadsheetApp.getUi();
  const event = EventAdmin.pickEvent_('設定を確認する開催を選んでください', null, ['終了']);
  if (!event) return;
  const ss = SheetUtils.openReservationSpreadsheet(event.spreadsheetUrl);
  ui.alert('設定の読み込み結果', Settings.describe(ss, event.name), ui.ButtonSet.OK);
}
