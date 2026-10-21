// ===== StateManager.gs =====
// ・会話の途中経過（今どのステップか、これまでの入力内容）はCacheServiceに一時保存します。
//   30分操作がないと自動的に消え、最初からやり直しになります。
// ・「動員する人の名前」は毎回聞き直さなくて済むよう、PropertiesServiceに長期保存します。

const StateManager = {
  get(userId) {
    const raw = CacheService.getScriptCache().get('state_' + userId);
    return raw ? JSON.parse(raw) : null;
  },

  set(userId, state) {
    CacheService.getScriptCache().put('state_' + userId, JSON.stringify(state), STATE_CACHE_SECONDS);
  },

  clear(userId) {
    CacheService.getScriptCache().remove('state_' + userId);
  },

  getLastOrganizerName(userId) {
    return PropertiesService.getScriptProperties().getProperty('organizer_' + userId);
  },

  setLastOrganizerName(userId, name) {
    PropertiesService.getScriptProperties().setProperty('organizer_' + userId, name);
  },
};
