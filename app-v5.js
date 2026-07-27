(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const PAGE_SIZE = 100;
  const ACCOUNT = 'p_horeer';
  const OWNER = '4k29';
  const REPO = 'TwitterDB';
  const BRANCH = 'main';
  const DELETED_PATH = 'deleted.json';
  const STATUS_PATH = 'tweet-status.json';
  const WORKFLOW_PATH = 'check-tweets.yml';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const $ = (id) => document.getElementById(id);

  const els = {
    type: $('typeFilter'), reply: $('replyFilter'), sort: $('sortOrder'), reset: $('resetFilters'),
    resultCount: $('resultCount'), rangeLabel: $('rangeLabel'), syncState: $('syncState'), syncBadge: $('syncBadge'),
    checkBadge: $('checkBadge'), checkVisible: $('checkVisible'), status: $('status'), list: $('tweetList'),
    loadMore: $('loadMore'), showDeleted: $('showDeleted'), deletedCount: $('deletedCount'),
    deletedDialog: $('deletedDialog'), closeDeleted: $('closeDeleted'), deletedQuery: $('deletedQuery'), deletedList: $('deletedList'),
    syncSettings: $('syncSettings'), syncDialog: $('syncDialog'), syncForm: $('syncForm'), closeSync: $('closeSync'),
    githubToken: $('githubToken'), saveToken: $('saveToken'), clearToken: $('clearToken'), syncMessage: $('syncMessage')
  };

  let allTweets = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let deletedIds = new Set();
  let tweetStatuses = {};
  let writeInProgress = false;
  let checkInProgress = false;

  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (token) => token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

  function setSync(label, state, detail = '') {
    els.syncBadge.textContent = label;
    els.syncBadge.dataset.state = state;
    els.syncState.textContent = detail || `GitHub同期：${label}`;
  }

  function setCheck(label, state = 'idle') {
    els.checkBadge.textContent = label;
    els.checkBadge.dataset.state = state;
  }

  function archiveRows() {
    const bucket = window.YTD?.tweets || {};
    return Object.values(bucket).flatMap((part) => Array.isArray(part) ? part : []);
  }

  function extractMentions(text) {
    const values = [];
    const seen = new Set();
    for (const match of String(text).matchAll(/@([A-Za-z0-9_]{1,15})\b/g)) {
      const handle = match[1];
      const key = handle.toLowerCase();
      if (!seen.has(key)) { seen.add(key); values.push(handle); }
    }
    return values;
  }

  function detectType(tweet, text) {
    if (tweet.retweeted_status || /^RT\s+@/i.test(text)) return 'repost';
    if (tweet.quoted_status_id_str || tweet.quoted_status_id || tweet.is_quote_status === true || tweet.is_quote_status === 'true') return 'quote';
    if (tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id || tweet.in_reply_to_user_id_str || tweet.in_reply_to_screen_name || /^@[A-Za-z0-9_]{1,15}\b/.test(text)) return 'reply';
    return 'post';
  }

  function normalizeRow(row) {
    const tweet = row?.tweet || row || {};
    const text = tweet.full_text || tweet.text || '';
    const id = String(tweet.id_str || tweet.id || '');
    const date = new Date(tweet.created_at || 0);
    const mentions = extractMentions(text);
    const replyTo = tweet.in_reply_to_screen_name || (text.match(/^@([A-Za-z0-9_]{1,15})\b/)?.[1] || '');
    if (replyTo && !mentions.some((name) => name.toLowerCase() === replyTo.toLowerCase())) mentions.unshift(replyTo);
    return {
      id, text, date, mentions, replyTo,
      likes: Number(tweet.favorite_count || 0),
      reposts: Number(tweet.retweet_count || 0),
      type: detectType(tweet, text),
      url: id ? `https://x.com/${ACCOUNT}/status/${id}` : '#'
    };
  }

  const typeLabel = (type) => ({ post: '通常投稿', reply: '返信', quote: '引用', repost: 'リポスト' })[type] || type;

  function formatDate(date) {
    if (Number.isNaN(date.getTime())) return ['日時不明', ''];
    return [
      new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
      new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(date)
    ];
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
  }

  function decodeBase64Utf8(value) {
    const binary = atob(String(value).replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function githubRequest(path, options = {}) {
    const token = options.token ?? getToken();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers, token: undefined });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function readJsonFile(path, token = '') {
    const data = await githubRequest(`/contents/${path}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`, { token });
    return { sha: data.sha, value: JSON.parse(decodeBase64Utf8(data.content)) };
  }

  async function loadRemoteState() {
    setSync('確認中…', 'loading', '削除状態を同期しています…');
    try {
      const remote = await readJsonFile(DELETED_PATH, '');
      deletedIds = new Set(Array.isArray(remote.value.deletedIds) ? remote.value.deletedIds.map(String) : []);
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      setSync(getToken() ? '接続済み' : '未設定', getToken() ? 'connected' : 'unset', getToken() ? 'GitHub同期：接続済み' : 'GitHub同期：閲覧のみ');
      applyFilters();
    } catch (error) {
      setSync('読込失敗', 'error', `削除状態を読み込めませんでした：${error.message}`);
    }
  }

  async function loadTweetStatuses(token = '') {
    try {
      const remote = await readJsonFile(STATUS_PATH, token);
      tweetStatuses = remote.value?.tweets || {};
      render();
      return tweetStatuses;
    } catch {
      tweetStatuses = {};
      render();
      return tweetStatuses;
    }
  }

  async function saveMutation(mutator, message) {
    if (!getToken()) { openSyncDialog('先にGitHub同期を設定してください。'); return false; }
    if (writeInProgress) return false;
    writeInProgress = true;
    setSync('保存中…', 'saving');
    try {
      const latest = await readJsonFile(DELETED_PATH, getToken());
      const ids = new Set(Array.isArray(latest.value.deletedIds) ? latest.value.deletedIds.map(String) : []);
      mutator(ids);
      const content = JSON.stringify({ deletedIds: [...ids].sort(), updatedAt: new Date().toISOString() }, null, 2) + '\n';
      await githubRequest(`/contents/${DELETED_PATH}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: encodeBase64Utf8(content), sha: latest.sha, branch: BRANCH })
      });
      deletedIds = ids;
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      setSync('保存済み', 'saved');
      applyFilters();
      return true;
    } catch (error) {
      setSync('保存失敗', 'error', `GitHub同期：保存失敗（${error.message}）`);
      return false;
    } finally { writeInProgress = false; }
  }

  function populateMentionFilter() {
    const counts = new Map();
    for (const tweet of allTweets) {
      for (const handle of tweet.mentions) {
        const key = handle.toLowerCase();
        const current = counts.get(key) || { label: handle, count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }
    const selected = els.reply.value;
    const options = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label));
    els.reply.innerHTML = '<option value="all">すべて</option>' + options.map(([key, item]) => `<option value="${escapeHtml(key)}">@${escapeHtml(item.label)}（${item.count}）</option>`).join('');
    if ([...els.reply.options].some((option) => option.value === selected)) els.reply.value = selected;
  }

  function applyFilters() {
    visibleCount = PAGE_SIZE;
    const type = els.type.value;
    const mention = els.reply.value;
    filtered = allTweets.filter((tweet) => {
      if (deletedIds.has(tweet.id)) return false;
      if (type !== 'all' && tweet.type !== type) return false;
      if (mention !== 'all' && !tweet.mentions.some((name) => name.toLowerCase() === mention)) return false;
      return true;
    });
    const sort = els.sort.value;
    filtered.sort((a, b) => sort === 'old' ? a.date - b.date : sort === 'likes' ? b.likes - a.likes || b.date - a.date : sort === 'reposts' ? b.reposts - a.reposts || b.date - a.date : b.date - a.date);
    render();
  }

  function statusInfo(id) {
    const value = tweetStatuses[id];
    if (!value) return { label: '未確認', state: 'unchecked', title: 'まだリンク先を確認していません' };
    if (value.status === 'exists') return { label: '存在', state: 'exists', title: `確認日時：${value.checkedAt || '不明'}` };
    if (value.status === 'deleted') return { label: '削除済み', state: 'deleted', title: `確認日時：${value.checkedAt || '不明'}` };
    return { label: '確認失敗', state: 'unknown', title: `HTTP ${value.httpStatus ?? '不明'} / ${value.checkedAt || '日時不明'}` };
  }

  function render() {
    els.resultCount.textContent = filtered.length.toLocaleString('ja-JP');
    if (filtered.length) {
      const valid = filtered.map((tweet) => tweet.date).filter((date) => !Number.isNaN(date.getTime()));
      els.rangeLabel.textContent = valid.length ? `${formatDate(new Date(Math.min(...valid)))[0]} 〜 ${formatDate(new Date(Math.max(...valid)))[0]}` : '日時不明';
    } else els.rangeLabel.textContent = '条件に一致する投稿はありません';
    const rows = filtered.slice(0, visibleCount);
    els.list.innerHTML = rows.length ? rows.map(tweetRow).join('') : '<p class="empty">投稿が見つかりませんでした。</p>';
    els.loadMore.hidden = visibleCount >= filtered.length;
    document.querySelectorAll('[data-delete-id]').forEach((button) => button.addEventListener('click', () => deleteTweet(button.dataset.deleteId, button)));
    document.querySelectorAll('[data-check-id]').forEach((button) => button.addEventListener('click', () => startCheck([button.dataset.checkId])));
  }

  function tweetRow(tweet) {
    const [date, time] = formatDate(tweet.date);
    const mentionBadges = tweet.mentions.map((name) => `<span class="badge">@${escapeHtml(name)}</span>`).join('');
    const linkStatus = statusInfo(tweet.id);
    return `<article class="tweet-row tweet-row-v5" data-id="${escapeHtml(tweet.id)}">
      <div class="tweet-date"><b>${escapeHtml(date)}</b>${escapeHtml(time)}</div>
      <div class="tweet-body"><a class="tweet-text" href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="badges"><span class="badge">${typeLabel(tweet.type)}</span>${mentionBadges}</div></div>
      <div class="metric likes"><span>いいね</span>${tweet.likes.toLocaleString('ja-JP')}</div>
      <span class="link-status" data-state="${linkStatus.state}" title="${escapeHtml(linkStatus.title)}">${linkStatus.label}</span>
      <button class="check-button" type="button" data-check-id="${escapeHtml(tweet.id)}">確認</button>
      <button class="delete-button" type="button" data-delete-id="${escapeHtml(tweet.id)}">削除</button>
    </article>`;
  }

  async function startCheck(ids) {
    ids = [...new Set(ids.map(String))].slice(0, 100);
    if (!ids.length || checkInProgress) return;
    if (!getToken()) { openSyncDialog('リンク確認にはActions権限を持つトークンが必要です。'); return; }
    checkInProgress = true;
    els.checkVisible.disabled = true;
    setCheck('確認中…', 'checking');
    const baseline = Object.fromEntries(ids.map((id) => [id, tweetStatuses[id]?.checkedAt || '']));
    try {
      await githubRequest(`/actions/workflows/${encodeURIComponent(WORKFLOW_PATH)}/dispatches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: BRANCH, inputs: { tweet_ids: ids.join(',') } })
      });
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 7000 : 5000));
        const statuses = await loadTweetStatuses(getToken());
        const completed = ids.every((id) => statuses[id]?.checkedAt && statuses[id].checkedAt !== baseline[id]);
        if (completed) { setCheck('確認済み', 'done'); return; }
      }
      setCheck('処理中', 'checking');
    } catch (error) {
      setCheck('確認失敗', 'error');
      els.status.hidden = false;
      els.status.textContent = `リンク確認を開始できませんでした：${error.message}`;
    } finally {
      checkInProgress = false;
      els.checkVisible.disabled = false;
    }
  }

  async function deleteTweet(id, button) {
    if (writeInProgress) return;
    button.disabled = true;
    button.textContent = '保存中';
    const ok = await saveMutation((ids) => ids.add(String(id)), `Exclude tweet ${id}`);
    if (!ok) { button.disabled = false; button.textContent = '削除'; }
  }

  async function restoreTweet(id, button) {
    button.disabled = true;
    button.textContent = '保存中';
    const ok = await saveMutation((ids) => ids.delete(String(id)), `Restore tweet ${id}`);
    if (ok) renderDeleted(); else { button.disabled = false; button.textContent = '復元'; }
  }

  function renderDeleted() {
    const query = els.deletedQuery.value.trim().toLocaleLowerCase('ja');
    const rows = allTweets.filter((tweet) => deletedIds.has(tweet.id) && (!query || tweet.text.toLocaleLowerCase('ja').includes(query))).sort((a, b) => b.date - a.date);
    els.deletedList.innerHTML = rows.length ? rows.map((tweet) => {
      const [date] = formatDate(tweet.date);
      return `<article class="deleted-row"><div class="tweet-date">${escapeHtml(date)}</div><a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="metric">${tweet.likes.toLocaleString('ja-JP')}</div><button class="secondary" type="button" data-restore-id="${escapeHtml(tweet.id)}">復元</button></article>`;
    }).join('') : '<p class="empty">削除済みの投稿はありません。</p>';
    document.querySelectorAll('[data-restore-id]').forEach((button) => button.addEventListener('click', () => restoreTweet(button.dataset.restoreId, button)));
  }

  function resetFilters() {
    els.type.value = 'all';
    els.reply.value = 'all';
    els.sort.value = 'new';
    applyFilters();
  }

  function openSyncDialog(message = '') {
    els.githubToken.value = getToken();
    els.syncMessage.textContent = message || (getToken() ? 'この端末にはトークンが保存されています。' : 'この端末ではまだ同期設定されていません。');
    els.syncDialog.showModal();
  }

  async function verifyAndSaveToken(event) {
    event.preventDefault();
    const token = els.githubToken.value.trim();
    if (!token) { els.syncMessage.textContent = 'トークンを入力してください。'; return; }
    els.saveToken.disabled = true;
    els.syncMessage.textContent = '接続を確認しています…';
    try {
      await readJsonFile(DELETED_PATH, token);
      setToken(token);
      els.syncMessage.textContent = '接続できました。この端末の同期設定を保存しました。';
      setSync('接続済み', 'connected');
      await Promise.all([loadRemoteState(), loadTweetStatuses(token)]);
    } catch (error) {
      els.syncMessage.textContent = `接続できませんでした：${error.message}`;
      setSync('接続失敗', 'error');
    } finally { els.saveToken.disabled = false; }
  }

  function clearToken() {
    setToken('');
    els.githubToken.value = '';
    els.syncMessage.textContent = 'この端末からトークンを削除しました。';
    setSync('未設定', 'unset', 'GitHub同期：閲覧のみ');
  }

  async function init() {
    allTweets = archiveRows().map(normalizeRow).filter((tweet) => tweet.id && tweet.text);
    if (!allTweets.length) {
      els.status.hidden = false;
      els.status.innerHTML = '<strong>tweets.js を読み込めませんでした。</strong><br>リポジトリ直下に <code>tweets.js</code> を配置してください。';
      return;
    }
    populateMentionFilter();
    applyFilters();
    await Promise.all([loadRemoteState(), loadTweetStatuses('')]);
  }

  [els.type, els.reply, els.sort].forEach((element) => element.addEventListener('change', applyFilters));
  els.reset.addEventListener('click', resetFilters);
  els.checkVisible.addEventListener('click', () => startCheck(filtered.slice(0, visibleCount).map((tweet) => tweet.id)));
  els.loadMore.addEventListener('click', () => { visibleCount += PAGE_SIZE; render(); });
  els.showDeleted.addEventListener('click', () => { renderDeleted(); els.deletedDialog.showModal(); });
  els.closeDeleted.addEventListener('click', () => els.deletedDialog.close());
  els.deletedQuery.addEventListener('input', renderDeleted);
  els.syncSettings.addEventListener('click', () => openSyncDialog());
  els.closeSync.addEventListener('click', () => els.syncDialog.close());
  els.syncForm.addEventListener('submit', verifyAndSaveToken);
  els.clearToken.addEventListener('click', clearToken);

  init();
})();
