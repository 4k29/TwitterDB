(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const repoContents = /https:\/\/api\.github\.com\/repos\/4k29\/TwitterDB\/contents\/(deleted\.json|tweet-status\.json)(?:\?|$)/;

  function toBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const match = url.match(repoContents);
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined));
    const authenticated = headers.has('Authorization');
    const method = String(init.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET').toUpperCase();

    // Anonymous reads do not need GitHub API. Reading from GitHub Pages is
    // same-origin, avoids API rate limits/CORS blockers, and is more reliable on iOS.
    if (match && !authenticated && method === 'GET') {
      const file = match[1];
      const response = await nativeFetch(`./${file}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return response;
      const text = await response.text();
      return new Response(JSON.stringify({
        sha: '',
        content: toBase64Utf8(text),
        encoding: 'base64'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return nativeFetch(input, init);
  };
})();
