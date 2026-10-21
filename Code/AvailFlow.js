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
