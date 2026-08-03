import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const archivePath = 'tweets.js';
const analyticsPath = 'analytics/data.js';
const categoriesPath = 'analytics/categories.js';

function readArchive() {
  const context = { window: { YTD: { tweets: {} } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(archivePath, 'utf8'), context);
  return Object.values(context.window.YTD.tweets)
    .flat()
    .map((row) => row?.tweet ?? row)
    .filter((tweet) => tweet?.id_str && tweet?.created_at);
}

function readCompressed(path, variable) {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path, 'utf8'), context);
  return JSON.parse(zlib.gunzipSync(Buffer.from(context.window[variable], 'base64')));
}

function writeCompressed(path, variable, value) {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 });
  fs.writeFileSync(path, `window.${variable}=${JSON.stringify(compressed.toString('base64'))};\n`);
}

function jstParts(value) {
  const shifted = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay()
  };
}

const tweets = readArchive();
const previousData = readCompressed(analyticsPath, 'ANALYTICS_DATA_GZIP');
const categories = readCompressed(categoriesPath, 'TWITTERDB_CATEGORY_GZIP');
const previousById = new Map(previousData.map((row) => [String(row.i), row]));
const categoryById = new Map(categories.rows.map((row) => [String(row[0]), row]));

for (const list of [categories.subjects, categories.topics, categories.postStyles]) {
  if (!list.includes('未分類')) list.push('未分類');
}

const unclassified = [
  categories.subjects.indexOf('未分類'),
  categories.topics.indexOf('未分類'),
  categories.postStyles.indexOf('未分類')
];

const rows = tweets.map((tweet) => {
  const id = String(tweet.id_str);
  const text = String(tweet.full_text || tweet.text || '');
  const previous = previousById.get(id);
  const category = categoryById.get(id) || [id, ...unclassified];
  const parts = jstParts(tweet.created_at);
  const repost = Boolean(tweet.retweeted_status || /^RT\s+@/i.test(text));
  const reply = Boolean(
    tweet.in_reply_to_status_id_str ||
    tweet.in_reply_to_user_id_str ||
    tweet.in_reply_to_screen_name ||
    /^@[A-Za-z0-9_]{1,15}\b/.test(text)
  );
  const hasUrl = /https?:\/\//i.test(text);

  return {
    d: parts.date,
    t: repost ? 'リポスト' : reply ? '返信' : '通常投稿',
    l: Number(tweet.favorite_count || 0),
    r: Number(tweet.retweet_count || 0),
    m: Number(previous?.m || 0),
    u: Number(previous?.u ?? hasUrl),
    n: [...text].length,
    h: parts.hour,
    w: parts.weekday,
    s: categories.subjects[category[1]],
    p: categories.topics[category[2]],
    f: categories.postStyles[category[3]],
    i: id,
    x: text
  };
}).sort((a, b) => a.d.localeCompare(b.d) || Number(BigInt(a.i) - BigInt(b.i)));

categories.rows = rows.map((row) => categoryById.get(row.i) || [row.i, ...unclassified]);

writeCompressed(analyticsPath, 'ANALYTICS_DATA_GZIP', rows);
writeCompressed(categoriesPath, 'TWITTERDB_CATEGORY_GZIP', categories);

const unclassifiedCount = rows.filter((row) => row.s === '未分類').length;
console.log(`Synced ${rows.length} analytics rows (${unclassifiedCount} unclassified).`);
