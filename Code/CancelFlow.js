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
