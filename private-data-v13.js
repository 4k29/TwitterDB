(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const OWNER = '4k29';
  const REPO = 'TwitterDB-data';
  const BRANCH = 'main';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const ANALYTICS_PENDING_TOKEN = '__twitterdb_analytics_unlock__';
  const isAnalyticsPage = typeof location !== 'undefined' && /\/analytics\/(?:index\.html)?$/.test(location.pathname);
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
    stylesheet.href = isAnalyticsPage ? '../simple-ui.css?v=4' : './simple-ui.css?v=4';
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
          await assignment('analytics/data.js', token);
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

  queueMicrotask(applySharedSimpleUi);
})();
