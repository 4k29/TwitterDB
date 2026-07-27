(() => {
  'use strict';

  const STORAGE_KEY = 'twitterdb:deleted:v1';
  const PAGE_SIZE = 100;
  const ACCOUNT = 'p_horeer';

  const $ = (id) => document.getElementById(id);
  const els = {
    query: $('query'), fromDate: $('fromDate'), toDate: $('toDate'), type: $('typeFilter'),
    reply: $('replyFilter'), sort: $('sortOrder'), reset: $('resetFilters'), resultCount: $('resultCount'),
    rangeLabel: $('rangeLabel'), status: $('status'), list: $('tweetList'), loadMore: $('loadMore'),
    showDeleted: $('showDeleted'), deletedCount: $('deletedCount'), deleteDialog: $('deleteDialog'),
    deleteExcerpt: $('deleteExcerpt'), confirmDelete: $('confirmDelete'), deletedDialog: $('deletedDialog'),
    closeDeleted: $('closeDeleted'), deletedQuery: $('deletedQuery'), deletedList: $('deletedList')
  };

  let allTweets = [];
  let filtered = [];
  let visibleCount = PAGE_SIZE;
  let pendingDeleteId = null;
  let deletedIds = loadDeleted();

  function loadDeleted() {
    try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
    catch { return new Set(); }
  }

  function saveDeleted() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...deletedIds]));
    els.deletedCount.textContent = deletedIds.size.toLocaleString('ja-JP');
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
    pendingDeleteId = id;
    const [date] = formatDate(tweet.date);
    els.deleteExcerpt.textContent = `${date}\n${tweet.text.slice(0, 220)}${tweet.text.length > 220 ? '…' : ''}`;
    els.deleteDialog.showModal();
  }

  function deletePending() {
    if (!pendingDeleteId) return;
    deletedIds.add(pendingDeleteId);
    pendingDeleteId = null;
    saveDeleted();
    applyFilters();
  }

  function restoreTweet(id) {
    deletedIds.delete(id);
    saveDeleted();
    renderDeleted();
    applyFilters();
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

  function init() {
    const rows = archiveRows();
    allTweets = rows.map(normalizeRow).filter((tweet) => tweet.id && tweet.text);
    saveDeleted();

    if (!allTweets.length) {
      els.status.hidden = false;
      els.status.innerHTML = '<strong>tweets.js を読み込めませんでした。</strong><br>このリポジトリのルートに、Xアーカイブ内の <code>data/tweets.js</code> を <code>tweets.js</code> という名前で配置してください。';
      els.rangeLabel.textContent = 'データ未読込';
      return;
    }

    populateReplyFilter();
    applyFilters();
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

  init();
})();
