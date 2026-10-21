// ===== Config.gs =====
// 実際の値はスクリプトエディタの「プロジェクトの設定」→「スクリプト プロパティ」で設定してください。
//   CONTROL_SHEET_ID          : 親（コントロール）シートのスプレッドシートID
//   LINE_CHANNEL_ACCESS_TOKEN : LINE Developersで発行したチャネルアクセストークン

const CONFIG = {
  CONTROL_SHEET_ID: PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID'),
  LINE_CHANNEL_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
};

// 親シート・開催別シートで使うタブ名
const SHEET_NAMES = {
  EVENT_MASTER: '開催マスタ',
  NOTIFY_LIST: '主催者通知先',
  TEMPLATE_LIST: 'ひな形',          // 親シート：開催シートのひな形一覧（ひな形名 / URL）
  STAFF_LIST: '対応者一覧',
  SLOT_MASTER: '枠マスタ',
  MENU_LIST: ['メニュー', '施術メニュー'], // 先に見つかった方を使う（旧ひな形との互換）
  RESERVATIONS: '予約',
  SETTINGS: '設定',
  DAY_SCHEDULE: '当日スケジュール',
  PENDING_LIST: '要確認リスト',
};

// 予約タブの列位置（見出しの文字ではなく位置で読むので、見出しは自由に変えられる）
const RES_COL = {
  id: 1, slot: 2, organizer: 3, guest: 4, age: 5, gender: 6, staff: 7, menu: 8, note: 9,
  createdAt: 10, status: 11, confirmedStaff: 12, confirmedSlot: 13, memo: 14,
  slotLabel: 15, dup: 16,
};
const RES_DATA_COLS = 14; // 値を読み書きする列数（O・P列は数式）

const STATUS = { ACCEPTED: '受付', PENDING: '要確認', CANCELED: 'キャンセル', CHANGED: '変更済' };

// 設定タブが無い・空欄のときに使う初期値（美容イベント版）
// enabled を false にできる項目: organizer / slot / age / gender / staff / menu / note / waitlist
// （guest は必須なので常にON。slot をOFFにすると時間枠を使わない開催＝全員同じ開始時刻のイベントになる）
const DEFAULT_SETTINGS = {
  organizer: { label: '動員する人', question: 'あなた（動員する人）のお名前を教えてください。', enabled: true, choices: [] },
  guest: { label: 'ゲスト名', question: 'ゲストのお名前を教えてください。', enabled: true, choices: [] },
  slot: { label: '時間枠', question: 'ご希望の時間枠を選んでください。', enabled: true, choices: [] },
  age: { label: '年齢(おおよそ)', question: 'ゲストの年齢（おおよそ）を教えてください。', enabled: true,
    choices: ['10代', '20代', '30代', '40代', '50代以上'] },
  gender: { label: '性別', question: '性別を教えてください。', enabled: true, choices: ['女性', '男性', '回答しない'] },
  // staff の choices は「対応者一覧の後ろに付ける選択肢」（例：誰でも良い）
  staff: { label: '希望する対応者', question: '希望する対応者はいますか？', enabled: true, choices: ['誰でも良い'] },
  menu: { label: '希望する施術', question: 'やって欲しい施術を選んでください（複数選択できます）。', enabled: true, choices: [] },
  // note の choices の先頭は「特になし」に当たる言葉（これが選ばれたら空欄として保存）
  note: { label: '伝えておきたいこと', question: '伝えておきたいことがあれば教えてください（アレルギーなど）。', enabled: true,
    choices: ['特になし'] },
  // 当日スケジュールの見出しなどに使う「対応する人」の呼び方
  staff_role: { label: '対応者', enabled: true, choices: [] },
  msg_accepted: { label: '受付完了メッセージ', text: '受け付けました（予約No.{no}）。', enabled: true, choices: [] },
  // 満席の枠を選べるようにするか。ON：満席でもキャンセル待ち（要確認）として受け付ける／OFF：満席の枠は出さず、受け付けない
  waitlist: { label: '満席でも受け付ける', enabled: true, choices: [] },
  // 全部の枠が満席のとき、登録を始める前に聞く文（このあと［進める］［やめる］を出す）
  msg_full: { label: '満席メッセージ',
    text: '申し訳ありません。現在は満席です。キャンセル待ち（要確認）としての登録になりますが、登録を進めますか？',
    enabled: true, choices: [] },
  // 「満席でも受け付ける」がOFFで、全部の枠が満席のときの返信
  msg_closed: { label: '受付終了メッセージ',
    text: '申し訳ありません。ご希望いただける枠は満席のため、受付できません。', enabled: true, choices: [] },
  // 同じ枠で同じ対応者を希望する人がすでにいるときの注意（{staff} は対応者名）
  msg_overlap: { label: '希望重複メッセージ',
    text: '※この枠の「{staff}」さんは、すでに他の方のご希望があります。担当者が変わる可能性があります。',
    enabled: true, choices: [] },
  msg_pending: { label: '要確認メッセージ',
    text: '現在満枠のため「要確認」として登録しました（予約No.{no}）。主催者確認後、あらためてご連絡します。',
    enabled: true, choices: [] },
};

// 会話状態（CacheService）の保持時間。この時間操作がないと最初からやり直しになる
const STATE_CACHE_SECONDS = 1800; // 30分

// LINEのクイックリプライは最大13個
const MAX_QUICK_REPLIES = 13;
