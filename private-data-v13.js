(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const OWNER = '4k29';
  const REPO = 'TwitterDB-data';
  const BRANCH = 'main';
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (token) => token
    ? localStorage.setItem(TOKEN_KEY, token)
    : localStorage.removeItem(TOKEN_KEY);

  async function api(path, options = {}) {
    const token = options.token ?? getToken();
    if (!token) throw new Error('非公開データ用のGitHubトークンが必要です。');
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
    if (!token) throw new Error('非公開データ用のGitHubトークンが必要です。');
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
    return parseAssignment(await text(path, token), path);
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
})();
