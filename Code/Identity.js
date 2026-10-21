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
