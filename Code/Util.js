// ===== Util.gs =====
const Util = {
  // 全角の数字・英字を半角に（「１」「ＯＦＦ」と入力されても読めるように）
  toHalfWidth(s) {
    return String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  },

  // 「{no}」のような差し込み文字を置き換える
  fillTemplate(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  },

  // 「2026/10/3」「2026-10-03」「20261003」「2026年10月3日」などを yyyymmdd と Date にする。失敗したら null
  parseDate(text) {
    const s = this.toHalfWidth(text);
    const m = s.match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    const pad = n => (n < 10 ? '0' + n : String(n));
    return { date: date, yyyymmdd: '' + y + pad(mo) + pad(d), display: y + '/' + pad(mo) + '/' + pad(d) };
  },

  // 表示用の短い日付「10/3」。取れなければ空文字
  shortDate(text) {
    const m = String(text).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? Number(m[2]) + '/' + Number(m[3]) : '';
  },
};
