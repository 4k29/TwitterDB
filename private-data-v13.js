(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const OWNER = '4k29';
  const REPO = 'TwitterDB-data';
  const BRANCH = 'main';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const ANALYTICS_PENDING_TOKEN = '__twitterdb_analytics_unlock__';
  const isAnalyticsSection = typeof location !== 'undefined' && /\/analytics\//.test(location.pathname);
  const isAnalyticsPage = isAnalyticsSection && /\/analytics\/(?:index\.html)?$/.test(location.pathname);
  let analyticsUnlocking = isAnalyticsPage && !localStorage.getItem(TOKEN_KEY);

  const getStoredToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const getToken = () => getStoredToken() || (analyticsUnlocking ? ANALYTICS_PENDING_TOKEN : '');
  const setToken = (token) => token
    ? localStorage.setItem(TOKEN_KEY, token)
    : localStorage.removeItem(TOKEN_KEY);

  function applySharedSimpleUi() {
    if (typeof document === 'undefined') return;

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = isAnalyticsSection ? '../simple-ui.css?v=4' : './simple-ui.css?v=4';
    stylesheet.dataset.twitterdbSimpleUi = 'v4';
    document.head.appendChild(stylesheet);

    if (!isAnalyticsPage) return;
    const shell = document.querySelector('.shell');
    if (!shell) return;

    if (!shell.querySelector('.site-header')) {
      const header = document.createElement('header');
      header.className = 'site-header';
      header.innerHTML = '<span class="site-brand">TwitterDB</span><nav class="site-nav" aria-label="ページ移動"><a class="active" href="./">アナリティクス</a><a href="./reviews.html">レビュー</a></nav>';
      shell.prepend(header);
    }

    shell.querySelector('.top-actions a[href="../"]')?.remove();

    if (!shell.querySelector('.hidden-db-link')) {
      const databaseLink = document.createElement('div');
      databaseLink.className = 'hidden-db-link';
      databaseLink.innerHTML = '<a href="../">投稿DBを開く</a>';
      shell.appendChild(databaseLink);
    }
  }

  function showAnalyticsUnlock(message = 'アナリティクスを表示するには、非公開データ用のGitHubトークンを設定してください。') {
    if (!isAnalyticsPage || typeof document === 'undefined') return;
    const modal = document.getElementById('syncModal');
    const input = document.getElementById('githubToken');
    const messageBox = document.getElementById('syncMessage');
    const save = document.getElementById('saveToken');
    const close = document.getElementById('closeSync');
    const clear = document.getElementById('clearToken');
    if (!modal || !input || !messageBox || !save) return;

    input.value = getStoredToken();
    messageBox.textContent = message;
    modal.classList.add('open');
    if (close) close.hidden = true;

    if (modal.dataset.unlockReady !== 'true') {
      modal.dataset.unlockReady = 'true';
      save.addEventListener('click', async () => {
        const token = input.value.trim();
        if (!token) {
          messageBox.textContent = 'トークンを入力してください。';
          return;
        }
        save.disabled = true;
        messageBox.textContent = '接続を確認しています…';
        try {
          await text('analytics/data.js', token);
          setToken(token);
          analyticsUnlocking = false;
          location.reload();
        } catch (error) {
          messageBox.textContent = `接続できませんでした：${error.message}`;
        } finally {
          save.disabled = false;
        }
      });
      clear?.addEventListener('click', () => {
        clearLocalData();
        input.value = '';
        messageBox.textContent = 'この端末に保存したトークンを削除しました。';
      });
    }

    queueMicrotask(() => input.focus());
  }

  async function api(path, options = {}) {
    const token = options.token ?? getToken();
    if (!token || token === ANALYTICS_PENDING_TOKEN) throw new Error('非公開データ用のGitHubトークンが必要です。');
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    };
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      token: undefined,
      cache: 'no-store'
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  function contentPath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  async function text(path, token = getToken()) {
    if (!token || token === ANALYTICS_PENDING_TOKEN) throw new Error('非公開データ用のGitHubトークンが必要です。');
    const response = await fetch(
      `${API_BASE}/contents/${contentPath(path)}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`
        }
      }
    );
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.text();
  }

  async function json(path, token = getToken()) {
    return JSON.parse(await text(path, token));
  }

  function parseAssignment(source, path) {
    const equalsAt = source.indexOf('=');
    if (equalsAt < 0) throw new Error(`${path} のデータ形式を読み取れません。`);
    const lineEnd = source.indexOf('\n', equalsAt);
    const valueSource = source
      .slice(equalsAt + 1, lineEnd < 0 ? source.length : lineEnd)
      .trim()
      .replace(/;\s*$/, '');
    return JSON.parse(valueSource);
  }

  async function assignment(path, token = getToken()) {
    if (token === ANALYTICS_PENDING_TOKEN) {
      showAnalyticsUnlock();
      return new Promise(() => {});
    }
    try {
      return parseAssignment(await text(path, token), path);
    } catch (error) {
      if (isAnalyticsPage && path === 'analytics/data.js' && token === getStoredToken()) {
        analyticsUnlocking = true;
        showAnalyticsUnlock(`非公開の分析データを読み込めませんでした：${error.message}`);
        return new Promise(() => {});
      }
      throw error;
    }
  }

  async function archive(token = getToken()) {
    const manifest = await json('tweet-archive/manifest.json', token);
    if (manifest.encoding !== 'gzip-base64' || !Array.isArray(manifest.parts) || !manifest.parts.length) {
      throw new Error('投稿アーカイブの構成を読み取れません。');
    }
    const chunks = await Promise.all(
      manifest.parts.map((name) => text(`tweet-archive/${name}`, token))
    );
    const compressed = Uint8Array.from(atob(chunks.join('').replace(/\s/g, '')), (char) => char.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const source = await new Response(stream).text();
    if (manifest.sourceBytes && new TextEncoder().encode(source).length !== manifest.sourceBytes) {
      throw new Error('投稿アーカイブのサイズが一致しません。');
    }
    return parseAssignment(source, 'tweet-archive');
  }

  async function setupAnalyticsLikesTrend() {
    if (!isAnalyticsPage || !getStoredToken() || typeof document === 'undefined') return;
    const trend = document.getElementById('trend');
    if (!trend) return;

    let rows = [];
    let deletedIds = new Set();
    try {
      const encoded = await assignment('analytics/data.js', getStoredToken());
      const compressed = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      rows = JSON.parse(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
      try {
        const deleted = await json('deleted.json', getStoredToken());
        deletedIds = new Set((deleted.deletedIds || []).map(String));
      } catch {}
    } catch {
      return;
    }

    const tab = document.querySelector('.tab-button[data-tab="trend"]');
    if (tab) tab.textContent = 'いいねの推移';
    const section = document.querySelector('#tab-trend .section-head');
    if (section) {
      const heading = section.querySelector('h2');
      const copy = section.querySelector('p');
      if (heading) heading.textContent = 'いいねの推移';
      if (copy) copy.textContent = '選択期間の日別いいね合計。反応数はアーカイブ取得時点の値です。';
    }

    const nf = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
    let timer = 0;

    function currentRows() {
      const start = document.getElementById('start')?.value || '';
      const end = document.getElementById('end')?.value || '';
      const type = document.getElementById('type')?.value || 'すべて';
      const key = document.getElementById('themeKey')?.value || 'p';
      const category = document.getElementById('themeCategory')?.value || '';
      return rows.filter((row) =>
        !deletedIds.has(String(row.i)) &&
        (!start || row.d >= start) &&
        (!end || row.d <= end) &&
        (type === 'すべて' || row.t === type) &&
        (!category || row[key] === category)
      );
    }

    function drawLikesTrend() {
      const selected = currentRows();
      const byDay = new Map();
      for (const row of selected) byDay.set(row.d, (byDay.get(row.d) || 0) + Number(row.l || 0));
      const days = [...byDay].sort((a, b) => a[0].localeCompare(b[0]));
      if (!days.length) {
        trend.innerHTML = '<div class="empty" data-likes-trend="true">該当する投稿がありません</div>';
        return;
      }

      const W = 900, H = 190, P = 16;
      const max = Math.max(...days.map(([, likes]) => likes), 1);
      const pts = days.map(([, likes], index) => [
        P + (W - P * 2) * (days.length === 1 ? 0.5 : index / (days.length - 1)),
        H - P - (H - P * 2) * likes / max
      ]);
      const line = pts.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
      const area = `${line} L ${pts.at(-1)[0]} ${H - P} L ${pts[0][0]} ${H - P} Z`;
      trend.innerHTML = `<svg class="trend" data-likes-trend="true" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="日別いいね数"><path d="${area}" fill="var(--accent-soft)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="axis-labels"><span>${days[0][0]}</span><span>最大 ${nf.format(max)}いいね/日</span><span>${days.at(-1)[0]}</span></div>`;
    }

    function scheduleDraw() {
      clearTimeout(timer);
      timer = setTimeout(drawLikesTrend, 20);
    }

    new MutationObserver(() => {
      if (!trend.querySelector('[data-likes-trend="true"]')) scheduleDraw();
    }).observe(trend, { childList: true, subtree: true });

    document.addEventListener('change', (event) => {
      if (event.target.closest('#start,#end,#type,#themeKey,#themeCategory')) scheduleDraw();
    });
    document.addEventListener('click', (event) => {
      if (event.target.closest('.quick button,.subtab,[data-category]')) scheduleDraw();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleDraw();
    });

    scheduleDraw();
  }

  async function version(token = getToken()) {
    const commit = await api(`/commits/${encodeURIComponent(BRANCH)}`, { token });
    return commit?.sha || '';
  }

  function clearLocalData() {
    setToken('');
    try { indexedDB.deleteDatabase('TwitterDBCache'); } catch {}
  }

  window.PrivateTwitterDB = {
    TOKEN_KEY,
    OWNER,
    REPO,
    BRANCH,
    API_BASE,
    getToken,
    setToken,
    api,
    text,
    json,
    assignment,
    archive,
    version,
    clearLocalData
  };

  queueMicrotask(() => {
    applySharedSimpleUi();
    setupAnalyticsLikesTrend();
  });
})();
