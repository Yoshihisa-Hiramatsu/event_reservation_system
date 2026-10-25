// ===== ChangeFlow.gs =====
// 「変更」フロー：時間枠・希望対応者・メニュー・伝達事項（設定でONの項目）を変更できる。
// ゲスト名を変えたい場合は、キャンセル→登録し直しの運用とする（合意済み）。

// 変更できる項目（設定でONのものだけ）。年齢・性別は入力ミスの訂正用
const CHANGEABLE_KEYS = ['slot', 'staff', 'menu', 'age', 'gender', 'note'];
const CHANGE_QUIT = 'やめる';
const CHANGE_QUIT_STEPS = ['INPUT_NEW_SLOT', 'INPUT_STAFF_AFTER_SLOT', 'INPUT_NEW_VALUE', 'INPUT_NEW_VALUE_MENU'];

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

    // 新しい内容を聞いている途中でも「やめる」で変更を中止できる（それまでの変更は破棄）
    if (text === CHANGE_QUIT && CHANGE_QUIT_STEPS.indexOf(state.step) !== -1) {
      StateManager.clear(userId);
      LineApi.reply(replyToken, '変更を中止しました。');
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
        const avail = this._availableSlots(ss, current);
        const slot = avail.find(s => SheetUtils.slotLabel(s) === text);
        if (!slot) {
          if (avail.length === 0) {
            // 選んでいる間に空き枠がなくなった → 他の項目の選択に戻す（固まって見えないように）
            state.data.unavailable = (state.data.unavailable || []).concat('slot');
            this._askMore(state, userId, replyToken, ss, st,
              `申し訳ありません。選んでいる間に空きがなくなりました。現在、変更できる空きの${st.slot.label}がありません。\n`);
            return;
          }
          LineApi.reply(replyToken, '申し訳ありません。その枠は満席になりました。空いている枠から選んでください。',
            RegisterFlow._withQuit(avail.map(s => SheetUtils.slotLabel(s))));
          return;
        }
        state.data.updates.slot = slot['枠番号'];
        // 希望する対応者が、新しい枠に対応していなければ、選び直してもらう
        const curStaff = state.data.updates.staff !== undefined ? state.data.updates.staff : current.staff;
        if (Settings.isOn(st, 'staff') && curStaff !== '' && curStaff !== undefined) {
          const eligible = SheetUtils.getStaffForSlot(ss, slot['枠番号']);
          if (eligible.indexOf(curStaff) === -1 && st.staff.choices.indexOf(curStaff) === -1) {
            const options = [...eligible, ...st.staff.choices];
            if (options.length > 0) {
              state.step = 'INPUT_STAFF_AFTER_SLOT';
              StateManager.set(userId, state);
              LineApi.reply(replyToken,
                `「${curStaff}」さんは${SheetUtils.slotLabel(slot)}に対応できません。\n新しい「${st.staff.label}」を選んでください。`,
                RegisterFlow._withQuit(options));
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
          LineApi.reply(replyToken, '選択肢の中から選んでください。', RegisterFlow._withQuit(options));
          return;
        }
        state.data.updates.staff = text;
        this._askMore(state, userId, replyToken, ss, st, '');
        return;
      }

      case 'INPUT_NEW_VALUE': {
        const key = state.data.target;
        if (key === 'staff') {
          const options = [...this._staffOptions(ss, st, state.data.rowIndex, state.data.updates.slot)];
          if (!options.includes(text)) {
            LineApi.reply(replyToken, '選択肢の中から選んでください。', RegisterFlow._withQuit(options));
            return;
          }
        }
        if ((key === 'age' || key === 'gender') && !RegisterFlow._validChoice(st, key, text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', RegisterFlow._withQuit(st[key].choices));
          return;
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

  // 満席の枠は変更先に選べないことの注意書き（満席の枠がなければ空）
  _fullSlotNote(ss, current) {
    const full = SheetUtils.getSlotAvailability(ss).filter(a => a.remaining <= 0 &&
      !(current && current.slot !== '' && Number(a.slot['枠番号']) === Number(current.slot)));
    return full.length > 0
      ? '\n※満席の枠は変更先に選べません。満席の枠をご希望の場合は、いったんキャンセルして「登録」からお申し込みください。' : '';
  },

  // 変更先に選べる時間枠：空きがある枠（いまの枠は除く）
  _availableSlots(ss, current) {
    return SheetUtils.getAvailableSlots(ss)
      .filter(s => !(current && current.slot !== '' && Number(s['枠番号']) === Number(current.slot)));
  },

  // 変更対象の予約の枠で対応できる人（枠が無い予約は全員）＋「誰でも良い」など
  // この変更の中で枠をすでに変えているときは、変更後の枠で対応できる人を出す
  _staffOptions(ss, st, rowIndex, newSlot) {
    const r = SheetUtils.getReservations(ss).find(x => x.rowIndex === rowIndex);
    const slot = (newSlot !== undefined && newSlot !== '') ? newSlot : (r ? r.slot : '');
    return [...SheetUtils.getStaffForSlot(ss, slot), ...st.staff.choices];
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
      LineApi.reply(replyToken, `新しい「${label}」を選んでください。` + this._fullSlotNote(ss, this._current(ss, state)), RegisterFlow._withQuit(options.map(s => SheetUtils.slotLabel(s))));
    } else if (key === 'staff') {
      state.step = 'INPUT_NEW_VALUE';
      StateManager.set(userId, state);
      LineApi.reply(replyToken, `新しい「${label}」を選んでください。`,
        RegisterFlow._withQuit(this._staffOptions(ss, st, state.data.rowIndex, state.data.updates.slot)));
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
      LineApi.reply(replyToken, `新しい「${label}」を入力してください。`, RegisterFlow._withQuit(st[key].choices));
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
