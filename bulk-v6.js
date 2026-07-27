(() => {
  'use strict';

  const TOKEN_KEY = 'twitterdb:github-token:v1';
  const OWNER = '4k29';
  const REPO = 'TwitterDB';
  const BRANCH = 'main';
  const PATH = 'deleted.json';
  const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const selected = new Set();

  const count = document.getElementById('selectedCount');
  const deleteButton = document.getElementById('deleteSelected');
  const clearButton = document.getElementById('clearSelected');
  const selectVisibleButton = document.getElementById('selectVisible');
  const toolbar = document.getElementById('bulkActions');
  const syncBadge = document.getElementById('syncBadge');

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function updateToolbar() {
    const size = selected.size;
    count.textContent = size.toLocaleString('ja-JP');
    deleteButton.disabled = size === 0;
    clearButton.disabled = size === 0;
    toolbar.dataset.active = size ? 'true' : 'false';
    document.querySelectorAll('[data-select-id]').forEach((input) => {
      input.checked = selected.has(input.dataset.selectId);
    });
  }

  function addCheckboxes() {
    document.querySelectorAll('.tweet-row[data-id]').forEach((row) => {
      const id = row.dataset.id;
      if (!id || row.querySelector('[data-select-id]')) return;
      const label = document.createElement('label');
      label.className = 'select-tweet';
      label.title = 'この投稿を選択';
      label.innerHTML = `<input type="checkbox" data-select-id="${id}" aria-label="この投稿を選択"><span></span>`;
      row.prepend(label);
      label.querySelector('input').checked = selected.has(id);
    });
  }

  document.addEventListener('change', (event) => {
    const input = event.target.closest('[data-select-id]');
    if (!input) return;
    if (input.checked) selected.add(input.dataset.selectId);
    else selected.delete(input.dataset.selectId);
    updateToolbar();
  });

  selectVisibleButton.addEventListener('click', () => {
    document.querySelectorAll('.tweet-row[data-id]').forEach((row) => selected.add(row.dataset.id));
    updateToolbar();
  });

  clearButton.addEventListener('click', () => {
    selected.clear();
    updateToolbar();
  });

  function decode(value) {
    const binary = atob(String(value).replace(/\n/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  function encode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      throw new Error(message || `GitHub API error ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  deleteButton.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!token()) {
      document.getElementById('syncSettings')?.click();
      return;
    }

    const idsToDelete = [...selected];
    deleteButton.disabled = true;
    deleteButton.textContent = '保存中…';
    if (syncBadge) {
      syncBadge.textContent = '保存中…';
      syncBadge.dataset.state = 'saving';
    }

    try {
      const latest = await request(`/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}&t=${Date.now()}`);
      const parsed = JSON.parse(decode(latest.content));
      const ids = new Set(Array.isArray(parsed.deletedIds) ? parsed.deletedIds.map(String) : []);
      idsToDelete.forEach((id) => ids.add(String(id)));
      const body = JSON.stringify({
        deletedIds: [...ids].sort(),
        updatedAt: new Date().toISOString()
      }, null, 2) + '\n';

      await request(`/contents/${PATH}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Exclude ${idsToDelete.length} selected tweets`,
          content: encode(body),
          sha: latest.sha,
          branch: BRANCH
        })
      });

      selected.clear();
      if (syncBadge) {
        syncBadge.textContent = '保存済み';
        syncBadge.dataset.state = 'saved';
      }
      window.location.reload();
    } catch (error) {
      deleteButton.disabled = false;
      deleteButton.textContent = '選択した投稿を削除';
      if (syncBadge) {
        syncBadge.textContent = '保存失敗';
        syncBadge.dataset.state = 'error';
      }
      const status = document.getElementById('status');
      if (status) {
        status.hidden = false;
        status.textContent = `一括削除の保存に失敗しました：${error.message}`;
      }
    }
  });

  const observer = new MutationObserver(() => {
    addCheckboxes();
    updateToolbar();
  });
  const list = document.getElementById('tweetList');
  if (list) observer.observe(list, { childList: true });
  addCheckboxes();
  updateToolbar();
})();
