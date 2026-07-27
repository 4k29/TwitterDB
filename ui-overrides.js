(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const API_URL = 'https://api.github.com/repos/4k29/TwitterDB/contents/deleted.json';
  const BRANCH = 'main';

  const badge = document.getElementById('syncBadge');
  const syncState = document.getElementById('syncState');
  let saving = false;

  function setBadge(label, state = '') {
    if (!badge) return;
    badge.textContent = label;
    badge.dataset.state = state;
  }

  function reflectCurrentState() {
    const text = syncState?.textContent || '';
    if (text.includes('保存しています')) return setBadge('保存中…', 'saving');
    if (text.includes('保存しました')) return setBadge('保存済み', 'saved');
    if (text.includes('保存失敗') || text.includes('読み込めません')) return setBadge('保存失敗', 'error');
    if (text.includes('接続済み')) return setBadge('接続済み', 'connected');
    if (text.includes('閲覧のみ') || text.includes('設定が必要')) return setBadge('未設定', 'unset');
    if (text.includes('同期しています') || text.includes('確認しています')) return setBadge('確認中…', 'loading');
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

  async function githubRequest(url, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.json();
  }

  async function deleteImmediately(id, button) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (!token) {
      document.getElementById('syncSettings')?.click();
      return;
    }
    if (saving) return;
    saving = true;
    button.disabled = true;
    button.textContent = '保存中';
    setBadge('保存中…', 'saving');
    if (syncState) syncState.textContent = 'GitHub同期：保存しています…';

    try {
      const current = await githubRequest(`${API_URL}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`);
      const parsed = JSON.parse(decodeBase64Utf8(current.content));
      const ids = new Set(Array.isArray(parsed.deletedIds) ? parsed.deletedIds.map(String) : []);
      ids.add(String(id));
      const body = JSON.stringify({
        deletedIds: [...ids].sort(),
        updatedAt: new Date().toISOString()
      }, null, 2) + '\n';

      await githubRequest(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Exclude tweet ${id}`,
          content: encodeBase64Utf8(body),
          sha: current.sha,
          branch: BRANCH
        })
      });

      setBadge('保存済み', 'saved');
      if (syncState) syncState.textContent = 'GitHub同期：保存済み';
      button.textContent = '保存済み';
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      setBadge('保存失敗', 'error');
      if (syncState) syncState.textContent = `GitHub同期：保存失敗（${error.message}）`;
      button.disabled = false;
      button.textContent = '削除';
      saving = false;
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-id]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    deleteImmediately(button.dataset.deleteId, button);
  }, true);

  if (syncState) {
    new MutationObserver(reflectCurrentState).observe(syncState, { childList: true, characterData: true, subtree: true });
  }
  reflectCurrentState();
})();
