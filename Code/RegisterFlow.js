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
      // 時間枠がある開催は、満席でも枠を選んでもらう（枠つきの要確認）。枠がない開催は枠なしの要確認
      state.data.waitlist = !Settings.isOn(st, 'slot');
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

  // 年齢・性別：選択肢が設定されているときは、その中から選ばせる（選択肢が空なら自由入力）
  _validChoice(st, key, text) {
    return st[key].choices.length === 0 || st[key].choices.indexOf(text) !== -1;
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
          if (!allowFull && available.length === 0) {
            // 迷っている間に全部埋まった → 受け付けない設定なので、ここで終わる
            StateManager.clear(userId);
            LineApi.reply(replyToken, st.msg_closed.text);
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
        if (!this._validChoice(st, 'age', text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', this._withQuit(st.age.choices));
          return;
        }
        d.age = text;
        this._next(state, userId, replyToken, ss, st, 'age', '');
        return;

      case 'ASK_GENDER':
        if (!this._validChoice(st, 'gender', text)) {
          LineApi.reply(replyToken, '選択肢の中から選んでください。', this._withQuit(st.gender.choices));
          return;
        }
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
        // すべて満席で、満席でも受け付けない設定なら、ここで受付終了
        if (available.length === 0 && !allowFull) {
          StateManager.clear(userId);
          LineApi.reply(replyToken, st.msg_closed.text);
          return true;
        }
        // 満席の枠も選べるときは、その枠がキャンセル待ちになることを質問の下に添える
        let note = '';
        if (allowFull) {
          if (available.length === 0) {
            note = '\n※すべての枠がキャンセル待ち（要確認）での受付になります。';
          } else {
            const fullNames = SheetUtils.getSlotAvailability(ss).filter(a => a.remaining <= 0)
              .map(a => `「${SheetUtils.slotLabel(a.slot)}」`);
            if (fullNames.length > 0) note = `\n※${fullNames.join('')}はキャンセル待ち（要確認）での受付になります。`;
          }
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
