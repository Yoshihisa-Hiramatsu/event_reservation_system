// ===== LineApi.gs =====
// LINE Messaging APIへの返信（reply）とプッシュ通知（push）をまとめたヘルパー。

const LineApi = {
  // choices を渡すとクイックリプライ（タップで同じ文言を送信）が付く
  reply(replyToken, text, choices) {
    const message = { type: 'text', text: text };
    if (choices && choices.length > 0) {
      if (choices.length > MAX_QUICK_REPLIES) {
        console.warn('選択肢が' + MAX_QUICK_REPLIES + '個を超えたため、先頭のみ表示します: ' + choices.length);
      }
      message.quickReply = { items: choices.slice(0, MAX_QUICK_REPLIES).map(this._quickReplyItem) };
    }
    this._call('https://api.line.me/v2/bot/message/reply', {
      replyToken: replyToken,
      messages: [message],
    });
  },

  push(userId, text) {
    this._call('https://api.line.me/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: text }],
    });
  },

  // LINEの表示名（取れなければ空文字）
  getDisplayName(userId) {
    try {
      const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText()).displayName || '';
    } catch (e) {
      console.warn('表示名を取得できませんでした: ' + e);
    }
    return '';
  },

  _quickReplyItem(label) {
    const shortLabel = String(label).slice(0, 20); // LINE仕様：ラベルは20文字まで
    return {
      type: 'action',
      action: { type: 'message', label: shortLabel, text: String(label) },
    };
  },

  _call(url, payload) {
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() >= 300) {
      console.error('LINE API error: ' + res.getResponseCode() + ' ' + res.getContentText());
    }
  },
};
