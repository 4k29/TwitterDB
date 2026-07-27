(() => {
  'use strict';

  const STATE_URL = './deleted.json';
  let checking = false;
  let timer = null;

  function localCount() {
    const value = document.getElementById('deletedCount')?.textContent || '0';
    return Number(value.replace(/[^0-9]/g, '')) || 0;
  }

  async function checkRemote() {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const response = await fetch(`${STATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const state = await response.json();
      const count = Array.isArray(state.deletedIds) ? state.deletedIds.length : 0;
      if (count !== localCount()) location.reload();
    } catch {
      // The main app displays synchronization errors. Keep this watcher silent.
    } finally {
      checking = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(checkRemote, 5000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkRemote();
  });
  window.addEventListener('focus', checkRemote);
  schedule();
})();
