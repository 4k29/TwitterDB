import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const statusPath = 'tweet-status.json';
const deletedPath = 'deleted.json';
const resultPath = 'purge-result.json';
const archivePath = 'tweets.js';
const analyticsPath = 'analytics/data.js';
const categoriesPath = 'analytics/categories.js';
const correctionsPath = 'analytics/corrections.json';

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function decodeGzipAssignment(source, variableName) {
  const pattern = new RegExp(`^${variableName.replaceAll('.', '\\.')}="([A-Za-z0-9+/=]+)";?\\s*$`);
  const match = source.match(pattern);
  if (!match) throw new Error(`${variableName} の圧縮データを読み取れません。`);
  return {
    value: JSON.parse(zlib.gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8')),
    encode(value) {
      const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }).toString('base64');
      return `${variableName}="${encoded}";\n`;
    }
  };
}

function parseArchive(source) {
  const equals = source.indexOf('=');
  const start = source.indexOf('[', equals);
  const end = source.lastIndexOf(']');
  if (equals < 0 || start < 0 || end < start) {
    throw new Error('tweets.js の投稿データを読み取れません。');
  }
  return {
    rows: JSON.parse(source.slice(start, end + 1)),
    prefix: source.slice(0, start),
    suffix: source.slice(end + 1)
  };
}

const store = await readJson(statusPath, { tweets: {}, updatedAt: null });
store.tweets ||= {};
const confirmedIds = new Set(
  Object.entries(store.tweets)
    .filter(([, value]) => value?.status === 'deleted')
    .map(([id]) => String(id))
);

let removedArchive = 0;
let removedAnalytics = 0;
let removedCategories = 0;
let removedCorrections = 0;

const archiveSource = await fs.readFile(archivePath, 'utf8');
const archive = parseArchive(archiveSource);
const archiveRows = archive.rows.filter((row) => {
  const tweet = row?.tweet || row || {};
  const id = String(tweet.id_str || tweet.id || '');
  if (!confirmedIds.has(id)) return true;
  removedArchive += 1;
  return false;
});
await fs.writeFile(
  archivePath,
  `${archive.prefix}${JSON.stringify(archiveRows, null, 2)}${archive.suffix}`
);

const analyticsSource = await fs.readFile(analyticsPath, 'utf8');
const analytics = decodeGzipAssignment(analyticsSource, 'window.ANALYTICS_DATA_GZIP');
const analyticsRows = analytics.value.filter((row) => {
  if (!confirmedIds.has(String(row?.i || ''))) return true;
  removedAnalytics += 1;
  return false;
});
await fs.writeFile(analyticsPath, analytics.encode(analyticsRows));

const categoriesSource = await fs.readFile(categoriesPath, 'utf8');
const categories = decodeGzipAssignment(categoriesSource, 'window.TWITTERDB_CATEGORY_GZIP');
categories.value.rows = (categories.value.rows || []).filter((row) => {
  if (!confirmedIds.has(String(row?.[0] || ''))) return true;
  removedCategories += 1;
  return false;
});
await fs.writeFile(categoriesPath, categories.encode(categories.value));

const corrections = await readJson(correctionsPath, { corrections: [], updatedAt: null });
corrections.corrections = (corrections.corrections || []).filter((item) => {
  if (!confirmedIds.has(String(item?.tweetId || ''))) return true;
  removedCorrections += 1;
  return false;
});

for (const id of confirmedIds) delete store.tweets[id];

const updatedAt = new Date().toISOString();
store.updatedAt = updatedAt;
corrections.updatedAt = updatedAt;

await Promise.all([
  fs.writeFile(statusPath, `${JSON.stringify(store, null, 2)}\n`),
  fs.writeFile(deletedPath, `${JSON.stringify({ deletedIds: [], updatedAt }, null, 2)}\n`),
  fs.writeFile(correctionsPath, `${JSON.stringify(corrections, null, 2)}\n`),
  fs.writeFile(resultPath, `${JSON.stringify({
    updatedAt,
    requestedCount: confirmedIds.size,
    removedCount: Math.max(removedArchive, removedAnalytics, removedCategories),
    removedArchive,
    removedAnalytics,
    removedCategories,
    removedCorrections
  }, null, 2)}\n`)
]);

console.log(
  `Purged ${removedArchive} archive row(s), ${removedAnalytics} analytics row(s), ` +
  `${removedCategories} category row(s), and ${removedCorrections} correction(s).`
);
