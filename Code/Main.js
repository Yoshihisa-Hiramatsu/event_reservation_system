// ===== Main.gs =====
// LINEからのWebhookを受け取る入口。
// Webアプリとしてデプロイし、そのURLをLINE DevelopersのWebhook URLに設定してください。

function doPost(e) {
  // 同じ人の操作が重なって会話の状態が上書きされないよう、処理を1件ずつ順番に行う
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(25000);
  } catch (err) {
    console.warn('ロックを取得できませんでした: ' + err);
  }
  try {
    const body = JSON.parse(e.postData.contents);
    const events = body.events || [];
    events.forEach(safeHandleEvent);
  } catch (err) {
    console.error('doPost error: ' + err + '\n' + (err && err.stack));
  } finally {
    if (locked) lock.releaseLock();
  }
  // LINE Platformへは常に200 OKを返す
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 1件の処理で例外が出ても、利用者に何も返らないままにならないよう、お詫びの返信を送る
function safeHandleEvent(event) {
  try {
    handleEvent(event);
  } catch (err) {
    console.error('handleEvent error: ' + err + '\n' + (err && err.stack));
    try {
      if (event && event.replyToken && event.type === 'message') {
        LineApi.reply(event.replyToken,
          'うまく処理できませんでした。お手数ですが、もう一度お送りください。うまくいかないときは「リセット」と送ると最初からやり直せます。');
      }
    } catch (err2) {
      console.error('error reply failed: ' + err2);
    }
  }
}

function handleEvent(event) {
  const userId = event.source && event.source.userId;
  if (!userId) return;

  // LINEが同じ通知を再送してきたときに、二重に処理しない
  if (event.webhookEventId) {
    const cache = CacheService.getScriptCache();
    const key = 'ev_' + event.webhookEventId;
    if (cache.get(key)) return;
    cache.put(key, '1', 600);
  }

  if (event.type === 'message' && event.message.type === 'text') {
    handleTextMessage(userId, event.replyToken, event.message.text.trim());
  }
  // 将来リッチメニューをpostback形式にする場合はここにhandlePostbackを追加
}

// 「通知登録 合言葉」「通知解除」：主催者がLINEから通知先に入る・外れる。処理したら true
function handleNotifyCommand(userId, replyToken, text) {
  const m = text.match(/^通知登録(?:[\s\u3000]+(.*))?$/);
  if (m) {
    const passcode = Util.toHalfWidth(SheetUtils.getNotifyPasscode());
    if (passcode === '') {
      LineApi.reply(replyToken, 'この操作は現在ご利用いただけません。');
      return true;
    }
    const given = Util.toHalfWidth((m[1] || '').trim());
    if (given === '') {
      LineApi.reply(replyToken, '「通知登録 合言葉」の形でお送りください。');
      return true;
    }
    if (given !== passcode) {
      LineApi.reply(replyToken, '合言葉が違います。');
      return true;
    }
    const result = SheetUtils.setNotifyUser(userId, LineApi.getDisplayName(userId) || '（LINEから登録）', true);
    LineApi.reply(replyToken, result === 'added'
      ? '通知先に登録しました。今後、新規登録・変更・キャンセルの通知が届きます。'
      : '通知をONにしました。');
    return true;
  }
  if (text === '通知解除') {
    const result = SheetUtils.setNotifyUser(userId, '', false);
    LineApi.reply(replyToken, result === 'off' ? '通知をOFFにしました。' : '通知先に登録されていません。');
    return true;
  }
  return false;
}

function handleTextMessage(userId, replyToken, text) {
  // 会話が止まってしまった場合の緊急リセット用
  if (text === 'リセット') {
    StateManager.clear(userId);
    LineApi.reply(replyToken, '操作をリセットしました。「登録」「キャンセル」「登録確認」「変更」「空き枠確認」のいずれかを送ってください。');
    return;
  }

  if (handleNotifyCommand(userId, replyToken, text)) return;

  const state = StateManager.get(userId);

  if (!state) {
    // 会話中でない場合は、トリガーワードとして判定する
    const flow = matchTrigger(text);
    if (flow) {
      startFlow(flow, userId, replyToken);
    } else {
      LineApi.reply(replyToken,
        'メニューから「登録」「キャンセル」「登録確認」「変更」「空き枠確認」のいずれかを送ってください。');
    }
    return;
  }

  // 会話中の場合は、現在のステップの続きとして処理する
  routeToFlow(state, userId, replyToken, text);
}

function matchTrigger(text) {
  if (text === '登録') return 'register';
  if (text === 'キャンセル') return 'cancel';
  if (text === '登録確認') return 'confirm';
  if (text === '変更') return 'change';
  if (text === '空き枠確認') return 'avail';
  return null;
}

// 募集中の開催が複数あれば、番号で選んでもらってから各フローを始める
function startFlow(flow, userId, replyToken) {
  const events = SheetUtils.getActiveEvents();
  if (events.length === 0) {
    LineApi.reply(replyToken, '現在募集中の開催がありません。主催者にご確認ください。');
    return;
  }
  if (events.length === 1) {
    beginFlow(flow, userId, replyToken, events[0]);
    return;
  }
  EventSelector.ask(flow, userId, replyToken, events);
}

function beginFlow(flow, userId, replyToken, event) {
  switch (flow) {
    case 'register': return RegisterFlow.start(userId, replyToken, event);
    case 'cancel': return CancelFlow.start(userId, replyToken, event);
    case 'confirm': return ConfirmFlow.start(userId, replyToken, event);
    case 'change': return ChangeFlow.start(userId, replyToken, event);
    case 'avail': return AvailFlow.start(userId, replyToken, event);
  }
}

function routeToFlow(state, userId, replyToken, text) {
  switch (state.flow) {
    case 'select_event': return EventSelector.handle(state, userId, replyToken, text);
    case 'register': return RegisterFlow.handle(state, userId, replyToken, text);
    case 'cancel': return CancelFlow.handle(state, userId, replyToken, text);
    case 'confirm': return ConfirmFlow.handle(state, userId, replyToken, text);
    case 'change': return ChangeFlow.handle(state, userId, replyToken, text);
    default:
      StateManager.clear(userId);
      LineApi.reply(replyToken, 'エラーが発生しました。もう一度メニューから選び直してください。');
  }
}
