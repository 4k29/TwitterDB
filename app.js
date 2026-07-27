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
    rangeLabel: $('rangeLabel'), syncState: $('syncState'), status: $('status'), list: $('tweetList'), loadMore: $('loadMore'),
    showDeleted: $('showDeleted'), deletedCount: $('deletedCount'), deleteDialog: $('deleteDialog'),
    deleteExcerpt: $('deleteExcerpt'), confirmDelete: $('confirmDelete'), deletedDialog: $('deletedDialog'),
    closeDeleted: $('closeDeleted'), deletedQuery: $('deletedQuery'), deletedList: $('deletedList'),
    syncSettings: $('syncSettings'), syncDialog: $('syncDialog'), syncForm: $('syncForm'), closeSync: $('closeSync'),
    githubToken: $('githubToken'), saveToken: $('saveToken'), clearToken: $('clearToken'), syncMessage: $('syncMessage')
  };

  let allTweets = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let pendingDeleteId = null;
  let deletedIds = new Set();
  let remoteSha = null;
  let writeInProgress = false;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function archiveRows() {
    const bucket = window.YTD?.tweets || {};
    return Object.values(bucket).flatMap((part) => Array.isArray(part) ? part : []);
  }

  function normalizeRow(row) {
    const t = row?.tweet || row || {};
    const text = t.full_text || t.text || '';
    const id = String(t.id_str || t.id || '');
    const date = new Date(t.created_at || 0);
    const replyTo = t.in_reply_to_screen_name || extractReplyHandle(text);
    const type = detectType(t, text);
    return {
      id,
      text,
      date,
      dateKey: Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10),
      likes: Number(t.favorite_count || 0),
      reposts: Number(t.retweet_count || 0),
      replyTo: replyTo || '',
      type,
      url: id ? `https://x.com/${ACCOUNT}/status/${id}` : '#'
    };
  }

  function extractReplyHandle(text) {
    const match = String(text).match(/^@([A-Za-z0-9_]{1,15})\b/);
    return match ? match[1] : '';
  }

  function detectType(t, text) {
    if (t.retweeted_status || /^RT\s+@/i.test(text)) return 'repost';
    if (t.quoted_status_id_str || t.quoted_status_id || t.is_quote_status === true || t.is_quote_status === 'true') return 'quote';
    if (t.in_reply_to_status_id_str || t.in_reply_to_status_id || t.in_reply_to_user_id_str || t.in_reply_to_screen_name || /^@[A-Za-z0-9_]{1,15}\b/.test(text)) return 'reply';
    return 'post';
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
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
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
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch {}
      const error = new Error(detail || `GitHub API error ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async function loadRemoteState() {
    els.syncState.textContent = '削除状態を同期しています…';
    try {
      const data = await githubRequest(`/contents/${STATE_PATH}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`, { token: '' });
      remoteSha = data.sha;
      const parsed = JSON.parse(decodeBase64Utf8(data.content));
      deletedIds = new Set(Array.isArray(parsed.deletedIds) ? parsed.deletedIds.map(String) : []);
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      els.syncState.textContent = getToken() ? 'GitHub同期：接続済み' : 'GitHub同期：閲覧のみ（同期設定が必要）';
      applyFilters();
      return true;
    } catch (error) {
      els.syncState.textContent = '削除状態を読み込めませんでした';
      showStatus(`deleted.jsonの読み込みに失敗しました。${escapeHtml(error.message)}`, true);
      return false;
    }
  }

  async function fetchWritableState(token) {
    const data = await githubRequest(`/contents/${STATE_PATH}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`, { token });
    const parsed = JSON.parse(decodeBase64Utf8(data.content));
    return {
      sha: data.sha,
      ids: new Set(Array.isArray(parsed.deletedIds) ? parsed.deletedIds.map(String) : [])
    };
  }

  async function saveRemoteMutation(mutator, commitMessage) {
    const token = getToken();
    if (!token) {
      openSyncDialog('削除・復元を同期するには、この端末でGitHubの同期設定をしてください。');
      throw new Error('GitHubの同期設定が必要です');
    }
    if (writeInProgress) throw new Error('別の同期処理が進行中です');
    writeInProgress = true;
    els.syncState.textContent = 'GitHubへ保存しています…';
    try {
      const latest = await fetchWritableState(token);
      mutator(latest.ids);
      const body = JSON.stringify({
        deletedIds: [...latest.ids].sort(),
        updatedAt: new Date().toISOString()
      }, null, 2) + '\n';
      const result = await githubRequest(`/contents/${STATE_PATH}`, {
        method: 'PUT',
        token,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage,
          content: encodeBase64Utf8(body),
          sha: latest.sha,
          branch: BRANCH
        })
      });
      remoteSha = result.content?.sha || null;
      deletedIds = latest.ids;
      els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
      els.syncState.textContent = 'GitHub同期：保存しました';
      hideStatus();
      applyFilters();
      return true;
    } catch (error) {
      els.syncState.textContent = 'GitHub同期：保存失敗';
      showStatus(`GitHubへの保存に失敗しました。${escapeHtml(error.message)}`, true);
      throw error;
    } finally {
      writeInProgress = false;
    }
  }

  function populateReplyFilter() {
    const counts = new Map();
    for (const tweet of allTweets) {
      if (!tweet.replyTo) continue;
      counts.set(tweet.replyTo, (counts.get(tweet.replyTo) || 0) + 1);
    }
    const current = els.reply.value;
    const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    els.reply.innerHTML = '<option value="all">すべて</option>' + options.map(([name, count]) => `<option value="${escapeHtml(name)}">@${escapeHtml(name)}（${count}）</option>`).join('');
    if ([...els.reply.options].some((option) => option.value === current)) els.reply.value = current;
  }

  function applyFilters() {
    visibleCount = PAGE_SIZE;
    const q = els.query.value.trim().toLocaleLowerCase('ja');
    const from = els.fromDate.value ? new Date(`${els.fromDate.value}T00:00:00`) : null;
    const to = els.toDate.value ? new Date(`${els.toDate.value}T23:59:59.999`) : null;
    const type = els.type.value;
    const reply = els.reply.value;

    filtered = allTweets.filter((tweet) => {
      if (deletedIds.has(tweet.id)) return false;
      if (q && !tweet.text.toLocaleLowerCase('ja').includes(q)) return false;
      if (from && tweet.date < from) return false;
      if (to && tweet.date > to) return false;
      if (type !== 'all' && tweet.type !== type) return false;
      if (reply !== 'all' && tweet.replyTo !== reply) return false;
      return true;
    });

    const sort = els.sort.value;
    filtered.sort((a, b) => {
      if (sort === 'old') return a.date - b.date;
      if (sort === 'likes') return b.likes - a.likes || b.date - a.date;
      if (sort === 'reposts') return b.reposts - a.reposts || b.date - a.date;
      return b.date - a.date;
    });

    render();
  }

  function render() {
    els.resultCount.textContent = filtered.length.toLocaleString('ja-JP');
    if (filtered.length) {
      const dates = filtered.map((tweet) => tweet.date).filter((date) => !Number.isNaN(date.getTime()));
      const min = new Date(Math.min(...dates));
      const max = new Date(Math.max(...dates));
      els.rangeLabel.textContent = `${formatDate(min)[0]} 〜 ${formatDate(max)[0]}`;
    } else {
      els.rangeLabel.textContent = '条件に一致する投稿はありません';
    }

    const rows = filtered.slice(0, visibleCount);
    els.list.innerHTML = rows.length ? rows.map(tweetRow).join('') : '<p class="empty">投稿が見つかりませんでした。</p>';
    els.loadMore.hidden = visibleCount >= filtered.length;
    bindRowActions();
  }

  function tweetRow(tweet) {
    const [date, time] = formatDate(tweet.date);
    const replyBadge = tweet.replyTo ? `<span class="badge">返信先 @${escapeHtml(tweet.replyTo)}</span>` : '';
    return `<article class="tweet-row" data-id="${escapeHtml(tweet.id)}">
      <div class="tweet-date"><b>${escapeHtml(date)}</b>${escapeHtml(time)}</div>
      <div class="tweet-body">
        <a class="tweet-text" href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a>
        <div class="badges"><span class="badge">${typeLabel(tweet.type)}</span>${replyBadge}</div>
      </div>
      <div class="metric likes"><span>いいね</span>${tweet.likes.toLocaleString('ja-JP')}</div>
      <div class="metric reposts"><span>リポスト</span>${tweet.reposts.toLocaleString('ja-JP')}</div>
      <button class="delete-button" type="button" data-delete-id="${escapeHtml(tweet.id)}">削除</button>
    </article>`;
  }

  function bindRowActions() {
    document.querySelectorAll('[data-delete-id]').forEach((button) => {
      button.addEventListener('click', () => openDeleteDialog(button.dataset.deleteId));
    });
  }

  function openDeleteDialog(id) {
    const tweet = allTweets.find((item) => item.id === id);
    if (!tweet) return;
    if (!getToken()) {
      openSyncDialog('先にGitHub同期を設定してください。設定後、もう一度削除を押してください。');
      return;
    }
    pendingDeleteId = id;
    const [date] = formatDate(tweet.date);
    els.deleteExcerpt.textContent = `${date}\n${tweet.text.slice(0, 220)}${tweet.text.length > 220 ? '…' : ''}`;
    els.deleteDialog.showModal();
  }

  async function deletePending() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    pendingDeleteId = null;
    try {
      await saveRemoteMutation((ids) => ids.add(id), `Exclude tweet ${id}`);
    } catch {}
  }

  async function restoreTweet(id) {
    try {
      await saveRemoteMutation((ids) => ids.delete(id), `Restore tweet ${id}`);
      renderDeleted();
    } catch {}
  }

  function renderDeleted() {
    const q = els.deletedQuery.value.trim().toLocaleLowerCase('ja');
    const rows = allTweets
      .filter((tweet) => deletedIds.has(tweet.id) && (!q || tweet.text.toLocaleLowerCase('ja').includes(q)))
      .sort((a, b) => b.date - a.date);
    els.deletedList.innerHTML = rows.length ? rows.map((tweet) => {
      const [date] = formatDate(tweet.date);
      return `<article class="deleted-row">
        <div class="tweet-date">${escapeHtml(date)}</div>
        <a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a>
        <div class="metric">${tweet.likes.toLocaleString('ja-JP')}</div>
        <button class="secondary" type="button" data-restore-id="${escapeHtml(tweet.id)}">復元</button>
      </article>`;
    }).join('') : '<p class="empty">削除済みの投稿はありません。</p>';
    document.querySelectorAll('[data-restore-id]').forEach((button) => button.addEventListener('click', () => restoreTweet(button.dataset.restoreId)));
  }

  function resetFilters() {
    els.query.value = '';
    els.fromDate.value = '';
    els.toDate.value = '';
    els.type.value = 'all';
    els.reply.value = 'all';
    els.sort.value = 'new';
    applyFilters();
  }

  function showStatus(message, isError = false) {
    els.status.hidden = false;
    els.status.innerHTML = message;
    els.status.dataset.kind = isError ? 'error' : 'info';
  }

  function hideStatus() {
    els.status.hidden = true;
    els.status.textContent = '';
  }

  function openSyncDialog(message = '') {
    els.githubToken.value = getToken();
    els.syncMessage.textContent = message || (getToken() ? 'この端末にはトークンが保存されています。' : 'この端末ではまだ同期設定されていません。');
    els.syncDialog.showModal();
  }

  async function verifyAndSaveToken(event) {
    event.preventDefault();
    const token = els.githubToken.value.trim();
    if (!token) {
      els.syncMessage.textContent = 'トークンを入力してください。';
      return;
    }
    els.saveToken.disabled = true;
    els.syncMessage.textContent = '接続を確認しています…';
    try {
      await fetchWritableState(token);
      setToken(token);
      els.syncMessage.textContent = '接続できました。この端末の同期設定を保存しました。';
      els.syncState.textContent = 'GitHub同期：接続済み';
      await loadRemoteState();
    } catch (error) {
      els.syncMessage.textContent = `接続できませんでした：${error.message}`;
    } finally {
      els.saveToken.disabled = false;
    }
  }

  function clearToken() {
    setToken('');
    els.githubToken.value = '';
    els.syncMessage.textContent = 'この端末からトークンを削除しました。閲覧と同期データの読み込みは引き続きできます。';
    els.syncState.textContent = 'GitHub同期：閲覧のみ（同期設定が必要）';
  }

  async function init() {
    const rows = archiveRows();
    allTweets = rows.map(normalizeRow).filter((tweet) => tweet.id && tweet.text);

    if (!allTweets.length) {
      els.status.hidden = false;
      els.status.innerHTML = '<strong>tweets.js を読み込めませんでした。</strong><br>このリポジトリのルートに、Xアーカイブ内の <code>data/tweets.js</code> を <code>tweets.js</code> という名前で配置してください。';
      els.rangeLabel.textContent = 'データ未読込';
      return;
    }

    populateReplyFilter();
    applyFilters();
    await loadRemoteState();
  }

  [els.query, els.fromDate, els.toDate, els.type, els.reply, els.sort].forEach((element) => {
    element.addEventListener(element === els.query ? 'input' : 'change', applyFilters);
  });
  els.reset.addEventListener('click', resetFilters);
  els.loadMore.addEventListener('click', () => { visibleCount += PAGE_SIZE; render(); });
  els.deleteDialog.addEventListener('close', () => {
    if (els.deleteDialog.returnValue === 'delete') deletePending();
    else pendingDeleteId = null;
  });
  els.showDeleted.addEventListener('click', () => { renderDeleted(); els.deletedDialog.showModal(); });
  els.closeDeleted.addEventListener('click', () => els.deletedDialog.close());
  els.deletedQuery.addEventListener('input', renderDeleted);
  els.syncSettings.addEventListener('click', () => openSyncDialog());
  els.closeSync.addEventListener('click', () => els.syncDialog.close());
  els.syncForm.addEventListener('submit', verifyAndSaveToken);
  els.clearToken.addEventListener('click', clearToken);

  init();
})();
