// ===== SheetUtils.gs =====
// 親（コントロール）シートと、開催ごとの予約シートファイルへのアクセスをまとめたヘルパー。

const SheetUtils = {
  getControlSheet() {
    return SpreadsheetApp.openById(CONFIG.CONTROL_SHEET_ID);
  },

  // ---------- 開催マスタ ----------

  // 開催マスタの全行（予約シートURLが入っているもの）
  getAllEvents() {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.EVENT_MASTER);
    const rows = sheet.getDataRange().getDisplayValues();
    const header = rows[0];
    const idx = name => header.indexOf(name);
    const iId = idx('開催ID'), iDate = idx('開催日'), iName = idx('開催名');
    const iUrl = idx('予約シートURL'), iStatus = idx('ステータス');

    return rows.slice(1)
      .filter(r => r[iId] !== '' && /\/d\/[a-zA-Z0-9-_]+/.test(r[iUrl]))
      .map(r => {
        const name = (iName >= 0 && r[iName] !== '') ? r[iName] : r[iId];
        const date = iDate >= 0 ? r[iDate] : '';
        const short = Util.shortDate(date);
        return {
          eventId: r[iId],
          name: name,
          date: date,
          label: short ? `${name}（${short}）` : name,
          spreadsheetUrl: r[iUrl],
          status: r[iStatus],
        };
      });
  },

  // 「募集中」の開催（複数可）
  getActiveEvents() {
    return this.getAllEvents().filter(e => e.status === '募集中');
  },

  openReservationSpreadsheet(url) {
    return SpreadsheetApp.openById(this.extractSpreadsheetId(url));
  },

  extractSpreadsheetId(url) {
    const m = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error('スプレッドシートURLからIDを取得できません: ' + url);
    return m[1];
  },

  // ---------- 開催別シートの読み込み ----------

  // 枠マスタ（見出しの文字で読む。列の見出しは変えないでください）
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
      })
      .filter(s => s['枠番号'] !== '');
  },

  slotLabel(slot) {
    // 開始時刻が空欄なら括弧を付けない（担当者ごとの枠など、時刻を出したくない使い方向け）
    const time = String(slot['開始時刻'] === undefined || slot['開始時刻'] === null ? '' : slot['開始時刻']).trim();
    return time === '' ? String(slot['枠名']) : `${slot['枠名']}(${time})`;
  },

  // 対応者一覧：A列（1列目）の2行目以降。見出しの文字は自由に変えてよい
  getStaffList(ss) {
    return this._firstColumn(ss.getSheetByName(SHEET_NAMES.STAFF_LIST));
  },

  // 選んだ枠で対応できる人だけを返す。
  //   対応者一覧のB列（対応可能時間帯）に、枠マスタの「枠名」をカンマ（, 、 ，）区切りで書くと、その枠でだけ選べる。
  //   ・B列が空欄の人／B列に枠名が1つも書かれていない人（「昼のみ」などのメモ）は、どの枠でも選べる
  //   ・slotNumber が空（時間枠を使わない・キャンセル待ち）なら全員を返す
  getStaffForSlot(ss, slotNumber) {
    const all = this.getStaffList(ss);
    if (slotNumber === '' || slotNumber === undefined || slotNumber === null) return all;
    const slots = this.getSlotList(ss);
    const chosen = slots.find(s => Number(s['枠番号']) === Number(slotNumber));
    if (!chosen) return all;
    const norm = v => Util.toHalfWidth(String(v)).trim();
    const slotNames = slots.map(s => norm(s['枠名']));
    const sheet = ss.getSheetByName(SHEET_NAMES.STAFF_LIST);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const width = Math.min(2, sheet.getMaxColumns());
    const rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues()
      .map(r => [r[0], width > 1 ? r[1] : '']);
    return rows
      .filter(r => String(r[0]).trim() !== '')
      .filter(r => {
        const tokens = String(r[1]).split(/[,、，\n]/).map(norm).filter(t => t !== '');
        const known = tokens.filter(t => slotNames.indexOf(t) !== -1);
        if (known.length === 0) return true; // 制限なし
        return known.indexOf(norm(chosen['枠名'])) !== -1;
      })
      .map(r => String(r[0]).trim());
  },

  // メニュー：A列（1列目）の2行目以降。「メニュー」タブ、なければ旧「施術メニュー」タブを使う
  getMenuList(ss) {
    for (const name of SHEET_NAMES.MENU_LIST) {
      const sheet = ss.getSheetByName(name);
      if (sheet) return this._firstColumn(sheet);
    }
    return [];
  },

  _firstColumn(sheet) {
    if (!sheet) return [];
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    return sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
      .map(r => String(r[0]).trim()).filter(v => v !== '');
  },

  // 予約タブ：列の位置（RES_COL）で読む。戻り値は { rowIndex, id, slot, organizer, guest, ... }
  getReservations(ss) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, RES_DATA_COLS).getValues();
    const result = [];
    values.forEach((row, i) => {
      // 予約IDもゲスト名も空の行は、数式だけが入った空き行なので読み飛ばす
      if (row[RES_COL.id - 1] === '' && row[RES_COL.guest - 1] === '') return;
      const obj = { rowIndex: i + 2 };
      Object.keys(RES_COL).forEach(key => {
        if (RES_COL[key] <= RES_DATA_COLS) obj[key] = row[RES_COL[key] - 1];
      });
      result.push(obj);
    });
    return result;
  },

  // 枠の受付可能人数。空欄・数字以外は「制限なし」として扱う
  _capacityOf(slot) {
    const raw = Util.toHalfWidth(slot['受付可能人数']).trim();
    if (raw === '') return Infinity;
    const n = Number(raw);
    return isNaN(n) ? Infinity : n;
  },

  // 枠ごとの空き状況。使った人数には「要確認（キャンセル待ち）」も含める
  // （キャンセルが出ても、待っている人より先に新しい人が入らないようにするため）
  getSlotAvailability(ss) {
    const counts = {};
    this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && r.slot !== '' && r.slot !== undefined)
      .forEach(r => { counts[Number(r.slot)] = (counts[Number(r.slot)] || 0) + 1; });
    return this.getSlotList(ss).map(s => {
      const capacity = this._capacityOf(s);
      const used = counts[Number(s['枠番号'])] || 0;
      return { slot: s, capacity: capacity, used: used, remaining: capacity - used };
    });
  },

  // まだ空きがある枠だけ
  getAvailableSlots(ss) {
    return this.getSlotAvailability(ss).filter(a => a.remaining > 0).map(a => a.slot);
  },

  // 時間枠を使わない開催：枠マスタの「受付可能人数」の合計をイベント全体の定員とみなす。
  // 枠マスタが空、または受付可能人数が空欄の行があれば「制限なし」
  isEventFull(ss) {
    const slots = this.getSlotList(ss);
    if (slots.length === 0) return false;
    const capacities = slots.map(s => this._capacityOf(s));
    if (capacities.some(c => c === Infinity)) return false;
    const total = capacities.reduce((a, b) => a + b, 0);
    const used = this.getReservations(ss).filter(r => r.status !== STATUS.CANCELED).length;
    return used >= total;
  },

  // 時間枠を使わない開催：あと何人受け付けられるか。制限なしなら Infinity
  getEventRemaining(ss) {
    const slots = this.getSlotList(ss);
    if (slots.length === 0) return Infinity;
    const capacities = slots.map(s => this._capacityOf(s));
    if (capacities.some(c => c === Infinity)) return Infinity;
    const total = capacities.reduce((a, b) => a + b, 0);
    const used = this.getReservations(ss).filter(r => r.status !== STATUS.CANCELED).length;
    return total - used;
  },

  // 同じ枠・同じ希望対応者で、すでにある予約の件数（キャンセルと excludeRowIndex の行は除く）
  countSameStaff(ss, slotNumber, staff, excludeRowIndex) {
    if (slotNumber === '' || slotNumber === undefined || slotNumber === null) return 0;
    if (staff === '' || staff === undefined || staff === null) return 0;
    return this.getReservations(ss).filter(r =>
      r.status !== STATUS.CANCELED && r.rowIndex !== excludeRowIndex &&
      r.slot !== '' && Number(r.slot) === Number(slotNumber) &&
      String(r.staff).trim() === String(staff).trim()).length;
  },

  // 指定した枠番号の現在の受付件数（キャンセルを除く）
  countReservationsInSlot(ss, slotNumber) {
    return this.getReservations(ss)
      .filter(r => Number(r.slot) === Number(slotNumber) && r.status !== STATUS.CANCELED)
      .length;
  },

  // ---------- 予約の書き込み ----------

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

    // 受付か要確認（キャンセル待ち）かを決める
    //   ・data.waitlist        : 満席と分かっている（空いている枠がない）→ 要確認
    //   ・data.slotOff         : 時間枠を使わない開催 → イベント全体の定員で判定
    //   ・それ以外             : 選んだ枠の定員で判定（登録の瞬間にもう一度確認する）
    const hasSlot = !data.slotOff && !data.waitlist &&
      data.slotNumber !== undefined && data.slotNumber !== '' && data.slotNumber !== null;
    let status = STATUS.ACCEPTED;
    if (data.waitlist) {
      status = STATUS.PENDING;
    } else if (data.slotOff) {
      if (this.isEventFull(ss)) status = STATUS.PENDING;
    } else {
      const slot = this.getSlotList(ss).find(s => Number(s['枠番号']) === Number(data.slotNumber));
      if (!slot) {
        status = STATUS.PENDING;
      } else {
        const currentCount = this.countReservationsInSlot(ss, data.slotNumber);
        status = (currentCount + 1) > this._capacityOf(slot) ? STATUS.PENDING : STATUS.ACCEPTED;
      }
    }

    sheet.getRange(targetRow, 1, 1, RES_DATA_COLS).setValues([[
      newId,
      hasSlot ? data.slotNumber : '',
      data.organizerName || '',
      data.guestName,
      data.age || '',
      data.gender || '',
      data.staff || '',
      (data.treatments || []).join('、'),
      data.note || '',
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
      status,
      '', // 確定担当者（前日ミーティングで記入）
      '', // 確定枠番号（同上）
      '', // 主催者メモ
    ]]);

    // 枠表示（O列）・重複チェック（P列）は数式で自動計算されるようにする
    // 「$B列が空欄でない」条件を加えて、空欄行同士が誤って重複判定されないようにしている
    sheet.getRange(targetRow, RES_COL.slotLabel).setFormula(
      `=IFERROR(VLOOKUP($B${targetRow},枠マスタ!$A:$E,2,FALSE)&IF(VLOOKUP($B${targetRow},枠マスタ!$A:$E,3,FALSE)&""="","","("&TEXT(VLOOKUP($B${targetRow},枠マスタ!$A:$E,3,FALSE),"HH:mm")&")"),"")`
    );
    sheet.getRange(targetRow, RES_COL.dup).setFormula(
      `=IF(AND($B${targetRow}<>"",COUNTIFS($B$2:$B,$B${targetRow},$G$2:$G,$G${targetRow},$K$2:$K,"<>キャンセル")>1),"⚠重複あり","")`
    );

    return { reservationId: newId, status: status };
  },

  // 動員する人の名前＋ゲスト名で予約を検索（キャンセル済みは除く）。[{ rowIndex, status }]
  findReservation(ss, organizerName, guestName) {
    return this.getReservations(ss)
      .filter(r => String(r.organizer).trim() === String(organizerName).trim() &&
                   String(r.guest).trim() === String(guestName).trim() &&
                   r.status !== STATUS.CANCELED)
      ; // 予約の全項目（rowIndex・status を含む）をそのまま返す
  },

  updateReservationStatus(ss, rowIndex, status) {
    this.updateReservationField(ss, rowIndex, 'status', status);
  },

  // key は RES_COL のキー名（'staff' 'menu' 'age' 'gender' 'note' 'status' など）
  updateReservationField(ss, rowIndex, key, value) {
    const col = RES_COL[key];
    if (!col) throw new Error('列が見つかりません: ' + key);
    ss.getSheetByName(SHEET_NAMES.RESERVATIONS).getRange(rowIndex, col).setValue(value);
  },

  // 「未決定」にした理由の表示用の文
  undecidedReason(reason) {
    return reason === 'any' ? '希望なし（誰でも良い）'
      : reason === 'ineligible' ? '希望の担当者が、この枠に対応できない'
      : '同じ枠で重複（先に別の予約に割り当て済み）';
  },

  // 確定担当者が実際に入っているか（空欄と「未決定」は入っていないとみなす）
  _hasConfirmedStaff(r) {
    const v = String(r.confirmedStaff === undefined || r.confirmedStaff === null ? '' : r.confirmedStaff).trim();
    return v !== '' && v !== UNDECIDED;
  },

  // 空欄の「確定担当者」「確定枠番号」を、希望の内容から自動で埋める（当日スケジュールの更新の前に呼ぶ）。
  //   対象：ステータスが「受付」「変更済」で、枠が決まっている予約（時間枠を使わない開催は何もしない）
  //   ・確定枠番号：空欄なら、お客様が選んだ枠番号を入れる
  //   ・確定担当者：空欄（または「未決定」）のとき、次の条件をすべて満たせば希望の担当者を入れる。
  //       具体的な人を希望している／その枠に対応できる／同じ枠で他の予約にまだ割り当てられていない（予約IDの順）
  //     満たさなければ「未決定」と入れる（当日スケジュールには出さない）
  //   手で入れた値は書き換えない。戻り値：{ slots: 確定枠を埋めた件数, staff: 確定担当者を埋めた件数,
  //     undecided: [{ guest, slotLabel, reason }] }  reason: 'any'（誰でも・希望なし）/ 'ineligible'（その枠に対応できない）/ 'taken'（同じ枠で割り当て済み）
  autoConfirm(ss) {
    const st = Settings.load(ss);
    const out = { slots: 0, staff: 0, undecided: [] };
    if (!Settings.isOn(st, 'slot')) return out;

    const slots = this.getSlotList(ss);
    const eligibleCache = {};
    const eligibleFor = n => {
      const k = String(n);
      if (!eligibleCache[k]) eligibleCache[k] = this.getStaffForSlot(ss, n);
      return eligibleCache[k];
    };
    const slotOf = r => (r.confirmedSlot !== '' && r.confirmedSlot !== undefined && r.confirmedSlot !== null) ? r.confirmedSlot : r.slot;
    const reservations = this.getReservations(ss).filter(r => r.status !== STATUS.CANCELED)
      .sort((a, b) => Number(a.id) - Number(b.id));

    // すでに割り当てられている「枠|担当者」（手で入れたものも含む）
    const taken = {};
    reservations.filter(r => this._hasConfirmedStaff(r)).forEach(r => {
      const n = slotOf(r);
      if (n !== '' && n !== undefined && n !== null) taken[String(n) + '|' + String(r.confirmedStaff).trim()] = true;
    });

    reservations.forEach(r => {
      if (r.status !== STATUS.ACCEPTED && r.status !== STATUS.CHANGED) return;
      const hasSlotNumber = r.slot !== '' && r.slot !== undefined && r.slot !== null;
      const confirmedSlotBlank = r.confirmedSlot === '' || r.confirmedSlot === undefined || r.confirmedSlot === null;
      if (confirmedSlotBlank && hasSlotNumber) {
        this.updateReservationField(ss, r.rowIndex, 'confirmedSlot', r.slot);
        r.confirmedSlot = r.slot;
        out.slots++;
      }
      const n = slotOf(r);
      if (n === '' || n === undefined || n === null) return;
      if (this._hasConfirmedStaff(r)) return; // 手で入れた（または割り当て済みの）担当者はそのまま

      const slot = slots.find(x => Number(x['枠番号']) === Number(n));
      const wish = String(r.staff === undefined || r.staff === null ? '' : r.staff).trim();
      let reason = '';
      if (wish === '' || st.staff.choices.indexOf(wish) !== -1) reason = 'any';
      else if (eligibleFor(n).indexOf(wish) === -1) reason = 'ineligible';
      else if (taken[String(n) + '|' + wish]) reason = 'taken';

      if (reason === '') {
        this.updateReservationField(ss, r.rowIndex, 'confirmedStaff', wish);
        taken[String(n) + '|' + wish] = true;
        out.staff++;
      } else {
        if (String(r.confirmedStaff).trim() !== UNDECIDED) this.updateReservationField(ss, r.rowIndex, 'confirmedStaff', UNDECIDED);
        out.undecided.push({ id: r.id, guest: r.guest, slotLabel: slot ? this.slotLabel(slot) : '枠' + n, reason: reason, wish: wish });
      }
    });
    return out;
  },

  // ---------- 当日スケジュール・要確認リスト ----------

  // 「確定担当者」が入っているのに、当日スケジュールに表示されない予約を返す（時間枠を使わない開催は空）。
  //   reason: 'staff'＝対応者一覧にない名前／'slot'＝確定枠番号（または枠番号）が枠マスタにない／'noslot'＝枠が決まっていない
  // 戻り値：[{ guest, reason, staff, slotNumber }]
  getUnschedulable(ss) {
    if (!Settings.isOn(Settings.load(ss), 'slot')) return [];
    const staffList = this.getStaffList(ss);
    const slots = this.getSlotList(ss);
    const result = [];
    this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && this._hasConfirmedStaff(r))
      .forEach(r => {
        const staff = String(r.confirmedStaff).trim();
        const slotNumber = (r.confirmedSlot !== '' && r.confirmedSlot !== undefined) ? r.confirmedSlot : r.slot;
        const item = { guest: r.guest, staff: staff, slotNumber: slotNumber };
        if (slotNumber === '' || slotNumber === undefined || slotNumber === null) {
          result.push(Object.assign(item, { reason: 'noslot' }));
        } else if (!slots.some(x => Number(x['枠番号']) === Number(slotNumber))) {
          result.push(Object.assign(item, { reason: 'slot' }));
        } else if (staffList.indexOf(staff) === -1) {
          result.push(Object.assign(item, { reason: 'staff' }));
        }
      });
    return result;
  },

  // 「確定担当者」が、確定した枠に対応できない予約を返す（時間枠を使わない開催は空）。
  // 対応できるかどうかは、登録時の「枠ごとの対応者」（対応者一覧のB列）と同じルールで判定する。
  // 戻り値：[{ guest, staff, slotNumber, slotLabel }]
  getUnavailableAssignments(ss) {
    if (!Settings.isOn(Settings.load(ss), 'slot')) return [];
    const staffList = this.getStaffList(ss);
    const slots = this.getSlotList(ss);
    const eligibleCache = {};
    const result = [];
    this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && this._hasConfirmedStaff(r))
      .forEach(r => {
        const slotNumber = (r.confirmedSlot !== '' && r.confirmedSlot !== undefined) ? r.confirmedSlot : r.slot;
        if (slotNumber === '' || slotNumber === undefined || slotNumber === null) return;
        const slot = slots.find(x => Number(x['枠番号']) === Number(slotNumber));
        if (!slot) return;
        const staff = String(r.confirmedStaff).trim();
        if (staffList.indexOf(staff) === -1) return; // 対応者一覧にない名前は、この判定の対象外
        const k = String(slotNumber);
        if (!eligibleCache[k]) eligibleCache[k] = this.getStaffForSlot(ss, slotNumber);
        if (eligibleCache[k].indexOf(staff) === -1) {
          result.push({ guest: r.guest, staff: staff, slotNumber: Number(slotNumber), slotLabel: this.slotLabel(slot) });
        }
      });
    return result;
  },

  // 当日スケジュール（行=枠、列=対応者）を対応者一覧・枠マスタ・予約タブから作り直す。
  // 「確定担当者」が入っている予約だけを反映する。同じ枠・同じ対応者に2人以上いる
  // セルはオレンジ色で目立たせる。戻り値は重複セルの件数。
  buildDaySchedule(ss, undecided) {
    const st = Settings.load(ss);
    let sheet = ss.getSheetByName(SHEET_NAMES.DAY_SCHEDULE);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.DAY_SCHEDULE);
    sheet.clear();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearNote();

    // 時間枠を使わない開催は、枠×対応者の表を作れないので、参加者の一覧（名簿）にする
    if (!Settings.isOn(st, 'slot')) return this._buildGuestList(ss, st, sheet);

    const staffList = this.getStaffList(ss);
    const slots = this.getSlotList(ss)
      .sort((a, b) => Number(a['枠番号']) - Number(b['枠番号']));

    sheet.getRange(1, 1).setValue(`枠＼${st.staff_role.label}`);
    staffList.forEach((staff, i) => sheet.getRange(1, 2 + i).setValue(staff));
    slots.forEach((slot, i) => {
      sheet.getRange(2 + i, 1).setValue(this.slotLabel(slot));
    });

    if (staffList.length > 0) {
      sheet.getRange(1, 1, 1, staffList.length + 1)
        .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
      // ゲスト名・メニューまで表示すると横幅が必要なので、対応者の列を広めにしておく
      for (let i = 0; i < staffList.length; i++) {
        sheet.setColumnWidth(2 + i, 220);
      }
    }
    if (slots.length > 0) {
      sheet.getRange(1, 1, slots.length + 1, 1)
        .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    }
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);

    // 「確定担当者」が入っている予約（キャンセル除く）だけを集計する
    const reservations = this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED && this._hasConfirmedStaff(r));

    const cellMap = {}; // "枠番号|担当者名" -> ["ゲスト名\n（動員する人）\nメニュー", ...]
    reservations.forEach(r => {
      const slotNumber = (r.confirmedSlot !== '' && r.confirmedSlot !== undefined) ? r.confirmedSlot : r.slot;
      const key = slotNumber + '|' + String(r.confirmedStaff).trim();
      if (!cellMap[key]) cellMap[key] = [];
      // 予約タブのどの行（予約ID）を直せばよいかが分かるよう、ゲスト名の前に予約番号を付ける
      const lines = [`【No.${r.id}】${r.guest}`];
      // 動員する人をOFFにしている開催では、動員する人＝ゲスト名なので表示しない
      if (Settings.isOn(st, 'organizer') && r.organizer) lines.push(`（${r.organizer}）`);
      if (r.menu) lines.push(r.menu);
      cellMap[key].push(lines.join('\n'));
    });

    // 対応できない枠に入っているセルの目印（枠番号|担当者名）
    const unavailable = {};
    this.getUnavailableAssignments(ss).forEach(u => { unavailable[u.slotNumber + '|' + u.staff] = true; });

    let duplicateCount = 0;
    slots.forEach((slot, rowOffset) => {
      staffList.forEach((staff, colOffset) => {
        const entries = cellMap[String(slot['枠番号']) + '|' + staff];
        if (!entries) return;
        const cell = sheet.getRange(2 + rowOffset, 2 + colOffset);
        // 1件＝最大3行（ゲスト名／動員する人／メニュー）。複数件ある場合は空行で区切って積む
        const bad = unavailable[Number(slot['枠番号']) + '|' + staff];
        const text = (bad ? '⚠この枠は対応できません\n' : '') + entries.join('\n\n');
        cell.setValue(text).setWrap(true).setVerticalAlignment('top');
        if (entries.length > 1) duplicateCount++;
        if (bad) {
          cell.setBackground('#F4C7C3'); // 対応できない枠に入っている＝赤系（重複のオレンジより優先）
        } else if (entries.length > 1) {
          cell.setBackground('#FDECC8'); // 1人が複数ゲストを担当＝重複を目立たせる
        }
      });
    });

    // 複数人が入っているセル（改行あり）があっても読めるよう、全体の行の高さを自動調整する
    if (slots.length > 0 && staffList.length > 0) {
      sheet.autoResizeRows(2, slots.length);
    }

    // 表の下に「未決定」の予約を一覧にする（自動確定で担当者を決められなかった予約）
    if (undecided && undecided.length > 0) {
      const top = slots.length + 3; // 表との間に1行あける
      sheet.getRange(top, 1).setValue(`未決定の予約（${undecided.length}件）：予約タブの「確定${st.staff_role.label}」に手で入力すると、次の更新から表に載ります。`)
        .setFontWeight('bold');
      const head = ['予約番号', st.guest.label, st.slot.label, `希望した${st.staff_role.label}`, '理由'];
      sheet.getRange(top + 1, 1, 1, head.length).setValues([head])
        .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
      const rows = undecided.map(u => ['No.' + u.id, u.guest, u.slotLabel, u.wish || '（希望なし）', this.undecidedReason(u.reason)]);
      sheet.getRange(top + 2, 1, rows.length, head.length).setValues(rows)
        .setWrap(true).setVerticalAlignment('top').setBackground('#FDECC8');
      sheet.autoResizeRows(top + 1, rows.length + 1);
    }

    return duplicateCount;
  },

  // 時間枠を使わない開催用：キャンセル以外の予約を、動員する人ごとの名簿にする。戻り値は常に0（重複の概念がない）
  _buildGuestList(ss, st, sheet) {
    const cols = []; // [見出し, 取り出し方]
    if (Settings.isOn(st, 'organizer')) cols.push([st.organizer.label, r => r.organizer]);
    cols.push([st.guest.label, r => r.guest]);
    if (Settings.isOn(st, 'age')) cols.push([st.age.label, r => r.age]);
    if (Settings.isOn(st, 'gender')) cols.push([st.gender.label, r => r.gender]);
    if (Settings.isOn(st, 'staff')) cols.push([st.staff.label, r => r.staff]);
    if (Settings.isOn(st, 'menu')) cols.push([st.menu.label, r => r.menu]);
    if (Settings.isOn(st, 'note')) cols.push([st.note.label, r => r.note]);
    if (Settings.isOn(st, 'staff')) cols.push(['確定' + st.staff_role.label, r => r.confirmedStaff]);
    cols.push(['ステータス', r => r.status]);

    sheet.getRange(1, 1, 1, cols.length).setValues([cols.map(c => c[0])])
      .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    for (let i = 0; i < cols.length; i++) sheet.setColumnWidth(1 + i, 160);

    const rows = this.getReservations(ss)
      .filter(r => r.status !== STATUS.CANCELED)
      .sort((a, b) => String(a.organizer).localeCompare(String(b.organizer), 'ja') || Number(a.id) - Number(b.id))
      .map(r => cols.map(c => c[1](r)));
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, cols.length).setValues(rows).setWrap(true).setVerticalAlignment('top');
    }
    return 0;
  },

  // 要確認リスト：ステータスが「要確認」の予約だけを一覧にする。戻り値は件数
  buildPendingList(ss) {
    const st = Settings.load(ss);
    let sheet = ss.getSheetByName(SHEET_NAMES.PENDING_LIST);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.PENDING_LIST);
    sheet.clear();

    const header = ['予約ID', '枠', st.organizer.label, st.guest.label, st.staff.label, '登録日時', '主催者メモ'];
    sheet.getRange(1, 1, 1, header.length).setValues([header])
      .setBackground('#0F6E56').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);

    const slotMap = {};
    this.getSlotList(ss).forEach(s => { slotMap[Number(s['枠番号'])] = this.slotLabel(s); });

    const rows = this.getReservations(ss)
      .filter(r => r.status === STATUS.PENDING)
      .map(r => [r.id, slotMap[Number(r.slot)] || r.slot || '（枠なし）', r.organizer, r.guest, r.staff, r.createdAt, r.memo]);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
    return rows.length;
  },

  // ---------- 通知 ----------

  // 親シート「主催者通知先」の「合言葉」列（2行目）。空欄なら LINEからの自動登録は使えない
  getNotifyPasscode() {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.NOTIFY_LIST);
    const rows = sheet.getDataRange().getValues();
    const i = rows[0].indexOf('合言葉');
    if (i < 0 || rows.length < 2) return '';
    return String(rows[1][i] === undefined || rows[1][i] === null ? '' : rows[1][i]).trim();
  },

  // LINEからの通知先登録・解除。戻り値：'added'（新規追加）/ 'on'（ONにした）/ 'off'（OFFにした）/ 'none'（登録なし）
  setNotifyUser(userId, name, on) {
    const sheet = this.getControlSheet().getSheetByName(SHEET_NAMES.NOTIFY_LIST);
    const rows = sheet.getDataRange().getValues();
    const header = rows[0];
    const iName = header.indexOf('主催者名');
    const iId = header.indexOf('LINE User ID');
    const iOnOff = header.indexOf('通知ON/OFF');
    let found = -1;
    let firstBlank = -1;
    for (let i = 1; i < rows.length; i++) {
      const id = String(rows[i][iId] === undefined ? '' : rows[i][iId]).trim();
      if (id === userId) { found = i; break; }
      if (id === '' && firstBlank === -1) firstBlank = i;
    }
    if (found !== -1) {
      sheet.getRange(found + 1, iOnOff + 1).setValue(on ? 'ON' : 'OFF');
      return on ? 'on' : 'off';
    }
    if (!on) return 'none';
    const row = (firstBlank !== -1 ? firstBlank : rows.length) + 1;
    if (iName >= 0) sheet.getRange(row, iName + 1).setValue(name);
    sheet.getRange(row, iId + 1).setValue(userId);
    sheet.getRange(row, iOnOff + 1).setValue('ON');
    return 'added';
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
