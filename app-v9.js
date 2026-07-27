(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const PAGE_SIZE = 100;
  const ACCOUNT = 'p_horeer';
  const OWNER = '4k29';
  const REPO = 'TwitterDB';
  const BRANCH = 'main';
  const DELETED_PATH = 'deleted.json';
  const KEPT_PATH = 'kept.json';
  const STATUS_PATH = 'tweet-status.json';
  const WORKFLOW_PATH = 'check-tweets.yml';
  const PURGE_WORKFLOW_PATH = 'purge-deleted.yml';
  const PURGE_RESULT_PATH = 'purge-result.json';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const $ = (id) => document.getElementById(id);

  const els = {
    type: $('typeFilter'), reply: $('replyFilter'), axis: $('categoryAxis'), category: $('categoryFilter'), sort: $('sortOrder'), reset: $('resetFilters'),
    resultCount: $('resultCount'), rangeLabel: $('rangeLabel'), syncState: $('syncState'), syncBadge: $('syncBadge'),
    checkBadge: $('checkBadge'), checkVisible: $('checkVisible'), status: $('status'), list: $('tweetList'),
    pagination: $('pagination'), prevPage: $('prevPage'), nextPage: $('nextPage'), pageLabel: $('pageLabel'),
    showKept: $('showKept'), keptCount: $('keptCount'), keptDialog: $('keptDialog'), closeKept: $('closeKept'), keptQuery: $('keptQuery'), keptList: $('keptList'),
    showDeleted: $('showDeleted'), deletedCount: $('deletedCount'), deletedDialog: $('deletedDialog'), closeDeleted: $('closeDeleted'), deletedQuery: $('deletedQuery'), deletedList: $('deletedList'),
    syncSettings: $('syncSettings'), syncDialog: $('syncDialog'), syncForm: $('syncForm'), closeSync: $('closeSync'),
    githubToken: $('githubToken'), saveToken: $('saveToken'), clearToken: $('clearToken'), syncMessage: $('syncMessage'),
    bulkActions: $('bulkActions'), selectedCount: $('selectedCount'), selectVisible: $('selectVisible'),
    clearSelected: $('clearSelected'), keepSelected: $('keepSelected'), checkSelected: $('checkSelected'), purgeDeleted: $('purgeDeleted')
  };

  let allTweets = [];
  let filtered = [];
  let currentPage = 0;
  let deletedIds = new Set();
  let keptIds = new Set();
  let totalPurged = 0;
  let tweetStatuses = {};
  let selectedIds = new Set();
  let writeInProgress = false;
  let checkInProgress = false;

  const dateFormatter = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormatter = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });
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

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
  }

  function archiveRows() {
    const bucket = window.YTD?.tweets || {};
    const rows = [];
    for (const part of Object.values(bucket)) {
      if (Array.isArray(part)) rows.push(...part);
    }
    return rows;
  }

  function extractMentions(text) {
    const values = [];
    const keys = [];
    const seen = new Set();
    for (const match of String(text).matchAll(/@([A-Za-z0-9_]{1,15})\b/g)) {
      const label = match[1];
      const key = label.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        values.push(label);
        keys.push(key);
      }
    }
    return { values, keys };
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
    const timestamp = Number.isNaN(date.getTime()) ? 0 : date.getTime();
    const mentions = extractMentions(text);
    const replyTo = tweet.in_reply_to_screen_name || (text.match(/^@([A-Za-z0-9_]{1,15})\b/)?.[1] || '');
    if (replyTo) {
      const key = replyTo.toLowerCase();
      if (!mentions.keys.includes(key)) {
        mentions.values.unshift(replyTo);
        mentions.keys.unshift(key);
      }
    }
    const category = window.TwitterDBCategories?.get(id) || { subject: '未分類', topic: '未分類', postStyle: '未分類' };
    return {
      id, text, timestamp,
      dateLabel: timestamp ? dateFormatter.format(date) : '日時不明',
      timeLabel: timestamp ? timeFormatter.format(date) : '',
      mentions: mentions.values,
      mentionKeys: mentions.keys,
      likes: Number(tweet.favorite_count || 0),
      reposts: Number(tweet.retweet_count || 0),
      type: detectType(tweet, text),
      subject: category.subject, topic: category.topic, postStyle: category.postStyle,
      url: id ? `https://x.com/${ACCOUNT}/status/${id}` : '#'
    };
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

  function rebuildMentionFilter() {
    const previous = els.reply.value;
    const labels = new Map();
    for (const tweet of allTweets) {
      if (deletedIds.has(tweet.id) || keptIds.has(tweet.id)) continue;
      tweet.mentionKeys.forEach((key, index) => {
        if (!labels.has(key)) labels.set(key, tweet.mentions[index]);
      });
    }
    const options = [...labels.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ja'));
    els.reply.innerHTML = '<option value="all">すべて</option>' + options.map(([key, label]) => `<option value="${escapeHtml(key)}">@${escapeHtml(label)}</option>`).join('');
    els.reply.value = labels.has(previous) ? previous : 'all';
  }

  function rebuildCategoryFilter() {
    const key = els.axis.value;
    const previous = els.category.value;
    const labels = [...new Set(allTweets.filter((tweet) => !deletedIds.has(tweet.id) && !keptIds.has(tweet.id)).map((tweet) => tweet[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    els.category.innerHTML = '<option value="all">すべて</option>' + labels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join('');
    els.category.value = labels.includes(previous) ? previous : 'all';
  }

  function applyFilters({ rebuildMentions = false, rebuildCategories = false } = {}) {
    if (rebuildMentions) rebuildMentionFilter();
    if (rebuildCategories) rebuildCategoryFilter();
    currentPage = 0;
    const type = els.type.value;
    const mention = els.reply.value;
    const categoryKey = els.axis.value;
    const category = els.category.value;
    filtered = allTweets.filter((tweet) => {
      if (deletedIds.has(tweet.id) || keptIds.has(tweet.id)) return false;
      if (type !== 'all' && tweet.type !== type) return false;
      if (mention !== 'all' && !tweet.mentionKeys.includes(mention)) return false;
      if (category !== 'all' && tweet[categoryKey] !== category) return false;
      return true;
    });
    const sort = els.sort.value;
    filtered.sort((a, b) => {
      if (sort === 'old') return a.timestamp - b.timestamp;
      if (sort === 'likes') return b.likes - a.likes || b.timestamp - a.timestamp;
      if (sort === 'reposts') return b.reposts - a.reposts || b.timestamp - a.timestamp;
      return b.timestamp - a.timestamp;
    });
    selectedIds = new Set([...selectedIds].filter((id) => filtered.some((tweet) => tweet.id === id)));
    render();
  }

  function typeLabel(type) {
    return ({ post: '通常投稿', reply: '返信', quote: '引用', repost: 'リポスト' })[type] || type;
  }

  function statusInfo(id) {
    const value = tweetStatuses[id];
    if (!value) return { label: '未確認', state: 'unchecked', title: 'まだリンク先を確認していません' };
    if (value.status === 'exists') return { label: '存在', state: 'exists', title: `確認日時：${value.checkedAt || '不明'}` };
    if (value.status === 'deleted') return { label: '削除済み', state: 'deleted', title: `確認日時：${value.checkedAt || '不明'}` };
    return { label: '確認失敗', state: 'unknown', title: `HTTP ${value.httpStatus ?? '不明'} / ${value.checkedAt || '日時不明'}` };
  }

  function tweetRow(tweet) {
    const linkStatus = statusInfo(tweet.id);
    const mentionBadges = tweet.mentions.map((name) => `<span class="badge">@${escapeHtml(name)}</span>`).join('');
    return `<article class="tweet-row tweet-row-v5" data-id="${escapeHtml(tweet.id)}">
      <label class="select-tweet" title="この投稿を選択"><input type="checkbox" data-select-id="${escapeHtml(tweet.id)}" ${selectedIds.has(tweet.id) ? 'checked' : ''}><span></span></label>
      <div class="tweet-date"><b>${escapeHtml(tweet.dateLabel)}</b>${escapeHtml(tweet.timeLabel)}</div>
      <div class="tweet-body"><a class="tweet-text" href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="badges"><span class="badge">${typeLabel(tweet.type)}</span><span class="badge">${escapeHtml(tweet.subject)}</span><span class="badge">${escapeHtml(tweet.topic)}</span><span class="badge">${escapeHtml(tweet.postStyle)}</span>${mentionBadges}</div></div>
      <div class="metric likes"><span>いいね</span>${tweet.likes.toLocaleString('ja-JP')}</div>
      <span class="link-status" data-state="${linkStatus.state}" title="${escapeHtml(linkStatus.title)}">${linkStatus.label}</span>
      <button class="check-button" type="button" data-check-id="${escapeHtml(tweet.id)}">確認</button>
    </article>`;
  }

  function updateBulkToolbar() {
    const count = selectedIds.size;
    els.selectedCount.textContent = count.toLocaleString('ja-JP');
    els.clearSelected.disabled = count === 0;
    els.keepSelected.disabled = count === 0 || writeInProgress;
    els.checkSelected.disabled = count === 0 || checkInProgress;
    els.purgeDeleted.disabled = writeInProgress;
    els.bulkActions.dataset.active = count ? 'true' : 'false';
  }

  function currentPageRows() {
    const start = currentPage * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }

  function render() {
    els.resultCount.textContent = filtered.length.toLocaleString('ja-JP');
    if (filtered.length) {
      els.rangeLabel.textContent = `${filtered[filtered.length - 1].dateLabel} 〜 ${filtered[0].dateLabel}`;
    } else {
      els.rangeLabel.textContent = '条件に一致する投稿はありません';
    }
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, pageCount - 1);
    const start = currentPage * PAGE_SIZE;
    const rows = currentPageRows();
    els.list.innerHTML = rows.length ? rows.map(tweetRow).join('') : '<p class="empty">投稿が見つかりませんでした。</p>';
    els.pagination.hidden = filtered.length === 0;
    els.prevPage.disabled = currentPage === 0;
    els.nextPage.disabled = currentPage >= pageCount - 1;
    const first = filtered.length ? start + 1 : 0;
    const last = Math.min(start + PAGE_SIZE, filtered.length);
    els.pageLabel.textContent = `${currentPage + 1} / ${pageCount}ページ ・ ${first}〜${last}件目`;
    updateBulkToolbar();
  }

  function updateDeletedCount() {
    els.deletedCount.textContent = (totalPurged + deletedIds.size).toLocaleString('ja-JP');
  }

  function updateKeptCount() {
    els.keptCount.textContent = keptIds.size.toLocaleString('ja-JP');
  }

  async function loadRemoteState() {
    setSync('確認中…', 'loading', '削除状態を同期しています…');
    try {
      const [remote, purge, kept] = await Promise.all([
        readJsonFile(DELETED_PATH, ''),
        readJsonFile(PURGE_RESULT_PATH, ''),
        readJsonFile(KEPT_PATH, '')
      ]);
      deletedIds = new Set(Array.isArray(remote.value.deletedIds) ? remote.value.deletedIds.map(String) : []);
      keptIds = new Set(Array.isArray(kept.value.keptIds) ? kept.value.keptIds.map(String) : []);
      totalPurged = Math.max(0, Number(purge.value?.totalPurged ?? purge.value?.removedCount ?? 0) || 0);
      updateDeletedCount();
      updateKeptCount();
      setSync(getToken() ? '接続済み' : '未設定', getToken() ? 'connected' : 'unset', getToken() ? 'GitHub同期：接続済み' : 'GitHub同期：閲覧のみ');
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
      return tweetStatuses;
    }
  }

  async function saveDeletedIds(mutator, message) {
    if (!getToken()) { openSyncDialog('先にGitHub同期を設定してください。'); return false; }
    if (writeInProgress) return false;
    writeInProgress = true;
    setSync('保存中…', 'saving');
    updateBulkToolbar();
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
      selectedIds.clear();
      updateDeletedCount();
      setSync('保存済み', 'saved');
      applyFilters({ rebuildMentions: true });
      return true;
    } catch (error) {
      setSync('保存失敗', 'error', `GitHub同期：保存失敗（${error.message}）`);
      return false;
    } finally {
      writeInProgress = false;
      updateBulkToolbar();
    }
  }

  async function saveKeptIds(mutator, message) {
    if (!getToken()) { openSyncDialog('ツイ消ししない投稿を保存するには、先にGitHub同期を設定してください。'); return false; }
    if (writeInProgress) return false;
    writeInProgress = true;
    setSync('保存中…', 'saving');
    updateBulkToolbar();
    try {
      const latest = await readJsonFile(KEPT_PATH, getToken());
      const ids = new Set(Array.isArray(latest.value.keptIds) ? latest.value.keptIds.map(String) : []);
      mutator(ids);
      const content = JSON.stringify({ keptIds: [...ids].sort(), updatedAt: new Date().toISOString() }, null, 2) + '\n';
      await githubRequest(`/contents/${KEPT_PATH}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: encodeBase64Utf8(content), sha: latest.sha, branch: BRANCH })
      });
      keptIds = ids;
      selectedIds.clear();
      updateKeptCount();
      setSync('保存済み', 'saved');
      applyFilters({ rebuildMentions: true, rebuildCategories: true });
      return true;
    } catch (error) {
      setSync('保存失敗', 'error', `ツイ消ししない投稿を保存できませんでした：${error.message}`);
      return false;
    } finally {
      writeInProgress = false;
      updateBulkToolbar();
    }
  }

  async function waitForPublishedPurge(updatedAt) {
    for (let attempt = 0; attempt < 36; attempt += 1) {
      try {
        const response = await fetch('./purge-result.json?t=' + Date.now(), { cache: 'no-store' });
        const published = await response.json();
        if (published.updatedAt === updatedAt) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return false;
  }

  async function purgeConfirmedDeleted() {
    if (!getToken()) { openSyncDialog('削除済み投稿の整理にはActions権限が必要です。'); return; }
    if (writeInProgress) return;
    writeInProgress = true;
    els.purgeDeleted.disabled = true;
    setSync('削除中…', 'saving');
    try {
      let baseline = '';
      try {
        baseline = (await readJsonFile(PURGE_RESULT_PATH, getToken())).value?.updatedAt || '';
      } catch {}
      await githubRequest(`/actions/workflows/${encodeURIComponent(PURGE_WORKFLOW_PATH)}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: BRANCH })
      });
      for (let attempt = 0; attempt < 36; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 7000 : 5000));
        const result = (await readJsonFile(PURGE_RESULT_PATH, getToken())).value || {};
        if (result.updatedAt && result.updatedAt !== baseline) {
          setSync('サイト反映中…', 'saving', '削除済みデータの公開を待っています…');
          const published = await waitForPublishedPurge(result.updatedAt);
          if (published) {
            setSync(`${Number(result.removedCount || 0).toLocaleString('ja-JP')}件削除`, 'saved');
            window.location.reload();
          } else {
            setSync('反映待ち', 'saving', '削除は完了しています。少し後に再読み込みしてください。');
          }
          return;
        }
      }
      setSync('処理中', 'saving', 'GitHub側で削除処理を続けています。少し待って再読み込みしてください。');
    } catch (error) {
      setSync('削除失敗', 'error', `削除済み投稿をDBから削除できませんでした：${error.message}`);
    } finally {
      writeInProgress = false;
      els.purgeDeleted.disabled = false;
      updateBulkToolbar();
    }
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
        if (ids.every((id) => statuses[id]?.checkedAt && statuses[id].checkedAt !== baseline[id])) {
          await loadRemoteState();
          applyFilters({ rebuildMentions: true, rebuildCategories: true });
          setCheck('確認済み', 'done');
          return;
        }
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

  function renderKept() {
    const query = els.keptQuery.value.trim().toLocaleLowerCase('ja');
    const rows = allTweets.filter((tweet) => keptIds.has(tweet.id) && (!query || tweet.text.toLocaleLowerCase('ja').includes(query))).sort((a, b) => a.timestamp - b.timestamp);
    els.keptList.innerHTML = rows.length ? rows.map((tweet) => `<article class="kept-row"><div class="tweet-date">${escapeHtml(tweet.dateLabel)}</div><a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="metric">${tweet.likes.toLocaleString('ja-JP')}</div><button class="secondary restore-kept" type="button" data-unkeep-id="${escapeHtml(tweet.id)}">投稿DBに戻す</button></article>`).join('') : '<p class="empty">ツイ消ししない投稿はまだありません。</p>';
  }

  function renderDeleted() {
    const query = els.deletedQuery.value.trim().toLocaleLowerCase('ja');
    const rows = allTweets.filter((tweet) => deletedIds.has(tweet.id) && (!query || tweet.text.toLocaleLowerCase('ja').includes(query))).sort((a, b) => b.timestamp - a.timestamp);
    els.deletedList.innerHTML = rows.length ? rows.map((tweet) => `<article class="deleted-row"><div class="tweet-date">${escapeHtml(tweet.dateLabel)}</div><a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tweet.text)}</a><div class="metric">${tweet.likes.toLocaleString('ja-JP')}</div></article>`).join('') : '<p class="empty">削除済みの投稿はありません。</p>';
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
      await loadTweetStatuses(token);
    } catch (error) {
      els.syncMessage.textContent = `接続できませんでした：${error.message}`;
      setSync('接続失敗', 'error');
    } finally {
      els.saveToken.disabled = false;
    }
  }

  async function init() {
    allTweets = archiveRows().map(normalizeRow).filter((tweet) => tweet.id && tweet.text);
    if (!allTweets.length) {
      els.status.hidden = false;
      els.status.innerHTML = '<strong>tweets.js を読み込めませんでした。</strong><br>リポジトリ直下に <code>tweets.js</code> を配置してください。';
      return;
    }
    await loadRemoteState();
    rebuildMentionFilter();
    rebuildCategoryFilter();
    applyFilters();
    const idle = window.requestIdleCallback || ((callback) => setTimeout(callback, 250));
    idle(() => loadTweetStatuses(''));
  }

  [els.type, els.reply, els.sort].forEach((element) => element.addEventListener('change', () => applyFilters()));
  els.axis.addEventListener('change', () => { rebuildCategoryFilter(); applyFilters(); });
  els.category.addEventListener('change', () => applyFilters());
  els.reset.addEventListener('click', () => {
    els.type.value = 'all'; els.reply.value = 'all'; els.axis.value = 'topic'; rebuildCategoryFilter(); els.category.value = 'all'; els.sort.value = 'old'; applyFilters();
  });
  els.prevPage.addEventListener('click', () => {
    currentPage = Math.max(0, currentPage - 1);
    render();
    els.list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  els.nextPage.addEventListener('click', () => {
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    currentPage = Math.min(pageCount - 1, currentPage + 1);
    render();
    els.list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  els.checkVisible.addEventListener('click', () => startCheck(currentPageRows().map((tweet) => tweet.id)));
  els.selectVisible.addEventListener('click', () => {
    currentPageRows().forEach((tweet) => selectedIds.add(tweet.id));
    render();
  });
  els.clearSelected.addEventListener('click', () => { selectedIds.clear(); render(); });
  els.keepSelected.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (ids.length) await saveKeptIds((kept) => ids.forEach((id) => kept.add(id)), `Keep ${ids.length} tweets`);
  });
  els.checkSelected.addEventListener('click', () => { const ids = [...selectedIds]; if (ids.length) startCheck(ids); });
  els.purgeDeleted.addEventListener('click', purgeConfirmedDeleted);
  els.list.addEventListener('change', (event) => {
    const input = event.target.closest('[data-select-id]');
    if (!input) return;
    input.checked ? selectedIds.add(input.dataset.selectId) : selectedIds.delete(input.dataset.selectId);
    updateBulkToolbar();
  });
  els.list.addEventListener('click', (event) => {
    const check = event.target.closest('[data-check-id]');
    if (check) { startCheck([check.dataset.checkId]); return; }

  });
  els.showKept.addEventListener('click', () => { renderKept(); els.keptDialog.showModal(); });
  els.closeKept.addEventListener('click', () => els.keptDialog.close());
  els.keptQuery.addEventListener('input', renderKept);
  els.keptList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-unkeep-id]');
    if (!button) return;
    button.disabled = true;
    const saved = await saveKeptIds((kept) => kept.delete(button.dataset.unkeepId), `Restore tweet ${button.dataset.unkeepId} to database`);
    if (saved) renderKept();
    else button.disabled = false;
  });
  els.showDeleted.addEventListener('click', () => { renderDeleted(); els.deletedDialog.showModal(); });
  els.closeDeleted.addEventListener('click', () => els.deletedDialog.close());
  els.deletedQuery.addEventListener('input', renderDeleted);
  els.syncSettings.addEventListener('click', () => openSyncDialog());
  els.closeSync.addEventListener('click', () => els.syncDialog.close());
  els.syncForm.addEventListener('submit', verifyAndSaveToken);
  els.clearToken.addEventListener('click', () => {
    setToken(''); els.githubToken.value = ''; els.syncMessage.textContent = 'この端末からトークンを削除しました。'; setSync('未設定', 'unset', 'GitHub同期：閲覧のみ');
  });

  init();
})();
