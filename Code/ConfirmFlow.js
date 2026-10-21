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
