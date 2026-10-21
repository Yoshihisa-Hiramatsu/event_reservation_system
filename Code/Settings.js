// ===== Settings.gs =====
// 開催別シートの「設定」タブを読み込む。タブが無い・空欄・「…」だけの項目は、Config.gsの初期値を使う。
//
// 設定タブの列：A=内部キー / B=表示名 / C=LINEの質問文（msg_で始まる行は返信メッセージ）/ D=使う(ON/OFF) / E=選択肢
// 選択肢はカンマ（, 、 ，）区切り。

const Settings = {
  REQUIRED: ['guest'], // OFFにできない項目

  load(ss) {
    const st = {};
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      st[key] = Object.assign({}, DEFAULT_SETTINGS[key], { choices: DEFAULT_SETTINGS[key].choices.slice() });
    });

    const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    if (sheet) {
      sheet.getDataRange().getDisplayValues().slice(1).forEach(r => {
        const key = Util.toHalfWidth(r[0]).trim();
        const item = st[key];
        if (!item) return;

        const label = this._text(r[1]);
        if (label) item.label = label;

        const body = this._text(r[2]);
        if (body) {
          if (key.indexOf('msg_') === 0) item.text = body; else item.question = body;
        }

        const onoff = this._onoff(r[3]);
        if (onoff === 'OFF') item.enabled = false;
        if (onoff === 'ON') item.enabled = true;

        const choices = this._choices(r[4]);
        if (choices.length > 0) item.choices = choices;
      });
    }
    this.REQUIRED.forEach(key => { st[key].enabled = true; });
    return st;
  },

  // 「ON」「OFF」のほか、全角・小文字・「オフ」「×」なども読み取る。判定できなければ ''
  _onoff(value) {
    const v = Util.toHalfWidth(value === null || value === undefined ? '' : value).trim().toUpperCase();
    if (['OFF', 'オフ', '×', '✕', 'NO', 'いいえ', '使わない'].indexOf(v) !== -1) return 'OFF';
    if (['ON', 'オン', '○', '〇', 'YES', 'はい', '使う'].indexOf(v) !== -1) return 'ON';
    return '';
  },

  isOn(st, key) {
    return !!st[key] && st[key].enabled !== false;
  },

  // 空欄や、書きかけの「…」で終わる文は「未設定」とみなして初期値に戻す
  _text(value) {
    const v = String(value === null || value === undefined ? '' : value).trim();
    if (v === '' || /…$/.test(v) || /\.\.\.$/.test(v)) return '';
    return v;
  },

  _choices(value) {
    return String(value === null || value === undefined ? '' : value)
      .split(/[,、，\n]/).map(s => s.trim()).filter(s => s !== '');
  },

  // 予約タブの見出しを設定の「表示名」に合わせる（列の位置は変わらない）
  applyHeaders(ss, st) {
    const sheet = ss.getSheetByName(SHEET_NAMES.RESERVATIONS);
    if (!sheet) return;
    sheet.getRange(1, 1, 1, 16).setValues([[
      '予約ID', '枠番号', st.organizer.label, st.guest.label, st.age.label, st.gender.label,
      st.staff.label, st.menu.label, st.note.label, '登録日時', 'ステータス',
      '確定' + st.staff_role.label, '確定枠番号', '主催者メモ', '枠表示', '重複チェック',
    ]]);
  },

  // 「どのファイルの設定を、どう読み込んだか」を確認用の文章にする（親シートのメニューから使う）
  describe(ss, eventName) {
    const lines = [`開催：${eventName}`, `読み込んだファイル：${ss.getName()}`];
    const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
    if (!sheet) {
      lines.push('', '⚠ このファイルに「設定」タブがありません。標準の文言（美容版）で動いています。');
      return lines.join('\n');
    }
    const st = this.load(ss);
    const rows = sheet.getDataRange().getDisplayValues().slice(1);
    const known = Object.keys(DEFAULT_SETTINGS);
    lines.push('');
    rows.forEach(r => {
      const key = Util.toHalfWidth(r[0]).trim();
      if (key === '') return;
      if (known.indexOf(key) === -1) {
        lines.push(`⚠ 「${key}」は認識できない内部キーです（無視されます）`);
        return;
      }
      const item = st[key];
      const body = key.indexOf('msg_') === 0 ? item.text : item.question;
      const sheetBody = String(r[2]).trim();
      const ignored = sheetBody !== '' && this._text(sheetBody) === '';
      const flag = this.REQUIRED.indexOf(key) !== -1 ? 'ON(必須)' : (item.enabled ? 'ON' : 'OFF');
      lines.push(`${key}：${flag}／${item.label}` + (body ? `／${body}` : '') + (ignored ? '　※質問文が「…」で終わっているため標準の文言を使用' : ''));
    });
    const missing = known.filter(k => !rows.some(r => Util.toHalfWidth(r[0]).trim() === k));
    if (missing.length > 0) lines.push('', '設定タブに無い行（標準の設定を使用）：' + missing.join(', '));
    return lines.join('\n');
  },
};
