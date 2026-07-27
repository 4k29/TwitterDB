(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const PAGE_SIZE = 100;
  const ACCOUNT = 'p_horeer';
  const OWNER = '4k29';
  const REPO = 'TwitterDB';
  const BRANCH = 'main';
  const STATE_PATH = 'deleted.json';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

  const $ = (id) => document.getElementById(id);
  const els = {
    query: $('query'), fromDate: $('fromDate'), toDate: $('toDate'), type: $('typeFilter'),
    reply: $('replyFilter'), sort: $('sortOrder'), reset: $('resetFilters'), resultCount: $('resultCount'),
    rangeLabel: $('rangeLabel'), syncState: $('syncState'), syncBadge: $('syncBadge'), status: $('status'),
    list: $('tweetList'), loadMore: $('loadMore'), showDeleted: $('showDeleted'), deletedCount: $('deletedCount'),
    deletedDialog: $('deletedDialog'), closeDeleted: $('closeDeleted'), deletedQuery: $('deletedQuery'), deletedList: $('deletedList'),
    syncSettings: $('syncSettings'), syncDialog: $('syncDialog'), syncForm: $('syncForm'), closeSync: $('closeSync'),
    githubToken: $('githubToken'), saveToken: $('saveToken'), clearToken: $('clearToken'), syncMessage: $('syncMessage')
  };

  let allTweets = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let deletedIds = new Set();
  let writeInProgress = false;

  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (token) => token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

  function setSync(label, state, detail = '') {
    els.syncBadge.textContent = label;
    els.syncBadge.dataset.state = state;
    els.syncState.textContent = detail || `GitHub同期：${label}`;
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
      if (!seen.has(key)) {
        seen.add(key);
        values.push(handle);
      }
    }
    return values;
  }

  function detectType(t, text) {
    if (t.retweeted_status || /^RT\s+@/i.test(text)) return 'repost';
    if (t.quoted_status_id_str || t.quoted_status_id || t.is_quote_status === true || t.is_quote_status === 'true') return 'quote';
    if (t.in_reply_to_status_id_str || t.in_reply_to_status_id || t.in_reply_to_user_id_str || t.in_reply_to_screen_name || /^@[A-Za-z0-9_]{1,15}\b/.test(text)) return 'reply';
    return 'post';
  }

  function normalizeRow(row) {
    const t = row?.tweet || row || {};
    const text = t.full_text || t.text || '';
    const id = String(t.id_str || t.id || '');
    const date = new Date(t.created_at || 0);
    const mentions = extractMentions(text);
    const replyTo = t.in_reply_to_screen_name || (text.match(/^@([A-Za-z0-9_]{1,15})\b/)?.[1] || '');
    if (replyTo && !mentions.some((name) => name.toLowerCase() === replyTo.toLowerCase())) mentions.unshift(replyTo);
    return {
      id, text, date, mentions, replyTo,
      likes: Number(t.favorite_count || 0),
      reposts: Number(t.retweet_count || 0),
      type: detectType(t, text),
      url: id ? `https://x.com/${ACCOUNT}/status/${id}` : '#'
    };
  }

  function typeLabel(type) {
    return ({ post: '通常投稿', reply: '返信', quote: '引用', repost: 'リポスト' })[type] || type;
  }

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
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers, token: undefined });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function readState(token = '') {
    const data = await githubRequest(`/contents/${STATE_PATH}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`, { token });
    const parsed = JSON.parse(decodeBase64Utf8(data.content));
    return { sha: data.sha, ids: new Set(Array.isArray(parsed.deletedIds) ? parsed.deletedIds.map(String) : []) };
  }

  async function loadRemoteState() {
    setSync('確認中…', 'loading', '削除状態を同期しています…');
    try {
      const remote = await readState('');
      deletedIds = remote.ids;
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      setSync(getToken() ? '接続済み' : '未設定', getToken() ? 'connected' : 'unset', getToken() ? 'GitHub同期：接続済み' : 'GitHub同期：閲覧のみ');
      applyFilters();
    } catch (error) {
      setSync('読込失敗', 'error', `削除状態を読み込めませんでした：${error.message}`);
    }
  }

  async function saveMutation(mutator, message) {
    if (!getToken()) {
      openSyncDialog('先にGitHub同期を設定してください。');
      return false;
    }
    if (writeInProgress) return false;
    writeInProgress = true;
    setSync('保存中…', 'saving');
    try {
      const latest = await readState(getToken());
      mutator(latest.ids);
      const content = JSON.stringify({ deletedIds: [...latest.ids].sort(), updatedAt: new Date().toISOString() }, null, 2) + '\n';
      await githubRequest(`/contents/${STATE_PATH}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: encodeBase64Utf8(content), sha: latest.sha, branch: BRANCH })
      });
      deletedIds = latest.ids;
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      setSync('保存済み', 'saved');
      applyFilters();
      return true;
    } catch (error) {
      setSync('保存失敗', 'error', `GitHub同期：保存失敗（${error.message}）`);
      return false;
    } finally {
      writeInProgress = false;
    }
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
    const q = els.query.value.trim().toLocaleLowerCase('ja');
    const from = els.fromDate.value ? new Date(`${els.fromDate.value}T00:00:00`) : null;
    const to = els.toDate.value ? new Date(`${els.toDate.value}T23:59:59.999`) : null;
    const type = els.type.value;
    const mention = els.reply.value;

    filtered = allTweets.filter((tweet) => {
      if (deletedIds.has(tweet.id)) return false;
      if (q && !tweet.text.toLocaleLowerCase('ja').includes(q)) return false;
      if (from && tweet.date < from) return false;
      if (to && tweet.date > to) return false;
      if (type !== 'all' && tweet.type !== type) return false;
      if (mention !== 'all' && !tweet.mentions.some((name) => name.toLowerCase() === mention)) return false;
      return true;
    });

    const sort = els.sort.value;
    filtered.sort((a, b) => sort === 'old' ? a.date - b.date : sort === 'likes' ? b.likes - a.likes || b.date - a.date : sort === 'reposts' ? b.reposts - a.reposts || b.date - a.date : b.date - a.date);
    render();
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
  }

  function tweetRow(tweet) {
    const [date, time] = formatDate(tweet.date);
    const mentionBadges = tweet.mentions.map((name) => `<span class="badge">@${escapeHtml(name)}</span>`).join('');
    return `<article class="tweet-row" data-id="${escapeHtml(tweet.id)}">
      <div class="tweet-date"><b>${escapeHtml(date)}</b>${escapeHtml(time)}</div>
      <div class="tweet-body"><a class="tweet-text" href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="badges"><span class="badge">${typeLabel(tweet.type)}</span>${mentionBadges}</div></div>
      <div class="metric likes"><span>いいね</span>${tweet.likes.toLocaleString('ja-JP')}</div>
      <div class="metric reposts"><span>リポスト</span>${tweet.reposts.toLocaleString('ja-JP')}</div>
      <button class="delete-button" type="button" data-delete-id="${escapeHtml(tweet.id)}">削除</button>
    </article>`;
  }

  async function deleteTweet(id, button) {
    if (writeInProgress) return;
    button.disabled = true;
    button.textContent = '保存中';
    const ok = await saveMutation((ids) => ids.add(String(id)), `Exclude tweet ${id}`);
    if (!ok) {
      button.disabled = false;
      button.textContent = '削除';
    }
  }

  async function restoreTweet(id, button) {
    button.disabled = true;
    button.textContent = '保存中';
    const ok = await saveMutation((ids) => ids.delete(String(id)), `Restore tweet ${id}`);
    if (ok) renderDeleted();
    else { button.disabled = false; button.textContent = '復元'; }
  }

  function renderDeleted() {
    const q = els.deletedQuery.value.trim().toLocaleLowerCase('ja');
    const rows = allTweets.filter((tweet) => deletedIds.has(tweet.id) && (!q || tweet.text.toLocaleLowerCase('ja').includes(q))).sort((a, b) => b.date - a.date);
    els.deletedList.innerHTML = rows.length ? rows.map((tweet) => {
      const [date] = formatDate(tweet.date);
      return `<article class="deleted-row"><div class="tweet-date">${escapeHtml(date)}</div><a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="metric">${tweet.likes.toLocaleString('ja-JP')}</div><button class="secondary" type="button" data-restore-id="${escapeHtml(tweet.id)}">復元</button></article>`;
    }).join('') : '<p class="empty">削除済みの投稿はありません。</p>';
    document.querySelectorAll('[data-restore-id]').forEach((button) => button.addEventListener('click', () => restoreTweet(button.dataset.restoreId, button)));
  }

  function resetFilters() {
    els.query.value = ''; els.fromDate.value = ''; els.toDate.value = ''; els.type.value = 'all'; els.reply.value = 'all'; els.sort.value = 'new'; applyFilters();
  }

  function openSyncDialog(message = '') {
    els.githubToken.value = getToken();
    els.syncMessage.textContent = message || (getToken() ? 'この端末にはトークンが保存されています。' : 'この端末ではまだ同期設定されていません。');
    els.syncDialog.showModal();
  }

  async function verifyAndSaveToken(event) {
    event.preventDefault();
    const token = els.githubToken.value.trim();
    if (!token) return void (els.syncMessage.textContent = 'トークンを入力してください。');
    els.saveToken.disabled = true;
    els.syncMessage.textContent = '接続を確認しています…';
    try {
      await readState(token);
      setToken(token);
      els.syncMessage.textContent = '接続できました。この端末の同期設定を保存しました。';
      setSync('接続済み', 'connected');
      await loadRemoteState();
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
    await loadRemoteState();
  }

  [els.query, els.fromDate, els.toDate, els.type, els.reply, els.sort].forEach((element) => element.addEventListener(element === els.query ? 'input' : 'change', applyFilters));
  els.reset.addEventListener('click', resetFilters);
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
