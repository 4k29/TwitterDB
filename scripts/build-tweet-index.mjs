import fs from 'node:fs';

const source = fs.readFileSync('tweets.js', 'utf8');
const equalsAt = source.indexOf('=');
if (equalsAt < 0) throw new Error('tweets.js assignment was not found');

const rows = JSON.parse(source.slice(equalsAt + 1).trim().replace(/;\s*$/, ''));
const compact = [];

for (const row of rows) {
  const tweet = row?.tweet ?? row ?? {};
  const text = tweet.full_text || tweet.text || '';
  const id = String(tweet.id_str || tweet.id || '');
  if (!id || !text) continue;

  const repost = Boolean(tweet.retweeted_status || /^RT\s+@/i.test(text));
  const quote = Boolean(
    tweet.quoted_status_id_str ||
    tweet.quoted_status_id ||
    tweet.is_quote_status === true ||
    tweet.is_quote_status === 'true'
  );
  const reply = Boolean(
    tweet.in_reply_to_status_id_str ||
    tweet.in_reply_to_status_id ||
    tweet.in_reply_to_user_id_str ||
    tweet.in_reply_to_screen_name ||
    /^@[A-Za-z0-9_]{1,15}\b/.test(text)
  );

  compact.push({
    i: id,
    x: text,
    d: tweet.created_at || '',
    l: Number(tweet.favorite_count || 0),
    r: Number(tweet.retweet_count || 0),
    p: tweet.in_reply_to_screen_name || '',
    t: repost ? 1 : 0,
    q: quote ? 1 : 0,
    y: reply ? 1 : 0
  });
}

fs.writeFileSync(
  'tweets-index.js',
  `window.TWITTER_DB_INDEX=${JSON.stringify(compact)};\n`,
  'utf8'
);

console.log(`Built ${compact.length} compact tweet records.`);
