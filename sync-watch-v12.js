(() => {
  'use strict';

  let busy = false;
  let readyAt = 0;

  function currentCount() {
    const text = document.getElementById('deletedCount')?.textContent || '0';
    return Number(text.replace(/[^0-9]/g, '')) || 0;
  }

  function isReady() {
    const state = document.getElementById('syncBadge')?.dataset.state || 'loading';
    return state !== 'loading' && state !== 'saving';
  }

  async function check() {
    if (busy || document.visibilityState === 'hidden' || !isReady()) return;
    if (!readyAt) readyAt = Date.now();
    if (Date.now() - readyAt < 15000) return;

    busy = true;
    try {
      const response = await fetch(`./deleted.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const remoteCount = Array.isArray(data.deletedIds) ? data.deletedIds.length : 0;
      if (remoteCount !== currentCount()) window.location.reload();
    } catch {
      // Keep background synchronization silent.
    } finally {
      busy = false;
    }
  }

  setInterval(check, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      readyAt = isReady() ? Date.now() - 15000 : 0;
      check();
    }
  });
})();
