(() => {
  'use strict';

  const select = document.getElementById('replyFilter');
  if (!select) return;

  function removeCounts() {
    for (const option of select.options) {
      if (option.value === 'all') continue;
      option.textContent = option.textContent.replace(/（[\d,]+）$/, '');
    }
  }

  const observer = new MutationObserver(removeCounts);
  observer.observe(select, { childList: true, subtree: true });
  removeCounts();
})();
