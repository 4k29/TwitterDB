import fs from 'node:fs/promises';

const ids = [...new Set(String(process.env.TWEET_IDS || '')
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter((value) => /^\d+$/.test(value)))]
  .slice(0, 100);

if (!ids.length) {
  throw new Error('確認する投稿IDがありません。');
}

const path = 'tweet-status.json';
let store = { tweets: {}, updatedAt: null };
try {
  store = JSON.parse(await fs.readFile(path, 'utf8'));
} catch {}
store.tweets ||= {};

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
  store.tweets[id] = await checkTweet(id);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

store.updatedAt = new Date().toISOString();
await fs.writeFile(path, `${JSON.stringify(store, null, 2)}\n`);
console.log(`Checked ${ids.length} tweet(s).`);
