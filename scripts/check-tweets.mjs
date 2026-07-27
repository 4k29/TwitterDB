import fs from 'node:fs/promises';

const ids = [...new Set(String(process.env.TWEET_IDS || '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter((value) => /^\d+$/.test(value)))]
  .slice(0, 100);

if (!ids.length) {
  throw new Error('確認する投稿IDがありません。');
}

const statusPath = 'tweet-status.json';
const deletedPath = 'deleted.json';

let store = { tweets: {}, updatedAt: null };
try {
  store = JSON.parse(await fs.readFile(statusPath, 'utf8'));
} catch {}
store.tweets ||= {};

let deletedStore = { deletedIds: [], updatedAt: null };
try {
  deletedStore = JSON.parse(await fs.readFile(deletedPath, 'utf8'));
} catch {}
const deletedIds = new Set(Array.isArray(deletedStore.deletedIds) ? deletedStore.deletedIds.map(String) : []);

async function checkTweet(id) {
  const tweetUrl = `https://x.com/p_horeer/status/${id}`;
  const endpoint = `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(tweetUrl)}`;
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(endpoint, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'TwitterDB link checker (GitHub Actions)',
        Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(20000)
    });

    let status = 'unknown';
    if (response.ok) status = 'exists';
    else if (response.status === 404) status = 'deleted';

    return {
      status,
      checkedAt,
      httpStatus: response.status,
      source: 'x-oembed'
    };
  } catch (error) {
    return {
      status: 'unknown',
      checkedAt,
      httpStatus: null,
      source: 'x-oembed',
      error: String(error?.message || error).slice(0, 240)
    };
  }
}

for (const id of ids) {
  const result = await checkTweet(id);
  store.tweets[id] = result;
  if (result.status === 'deleted') deletedIds.add(id);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

const updatedAt = new Date().toISOString();
store.updatedAt = updatedAt;
deletedStore = {
  deletedIds: [...deletedIds].sort(),
  updatedAt
};

await Promise.all([
  fs.writeFile(statusPath, `${JSON.stringify(store, null, 2)}\n`),
  fs.writeFile(deletedPath, `${JSON.stringify(deletedStore, null, 2)}\n`)
]);
console.log(`Checked ${ids.length} tweet(s); ${deletedIds.size} tweet(s) are excluded.`);
