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
