import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { privateDirectory } from "./private-directory.mjs";
import { execFileSync } from "node:child_process";
import { archiveRows, backtest, estimate } from "../lib/prediction.mjs";
const root = await privateDirectory(process.env.TWITTERDB_DATA_DIR);
const manifest = JSON.parse(
  await readFile(join(root, "tweet-archive/manifest.json"), "utf8"),
);
const chunks = await Promise.all(
  manifest.parts.map((p) => readFile(join(root, "tweet-archive", p), "utf8")),
);
const source = gunzipSync(
  Buffer.from(chunks.join("").replace(/\s/g, ""), "base64"),
).toString();
const raw = JSON.parse(source.slice(source.indexOf("[")).replace(/;\s*$/, ""));
const tweets = raw.map((r) => r.tweet || r),
  ids = tweets.map((r) => r.id_str),
  fields = {};
for (const t of tweets)
  for (const k of Object.keys(t)) fields[k] = (fields[k] || 0) + 1;
const dates = tweets
  .map((t) => Date.parse(t.created_at))
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
const deleted = JSON.parse(await readFile(join(root, "deleted.json"), "utf8"));
const rows = archiveRows(
  raw,
  new Map(),
  new Set((deleted.deletedIds || []).map(String)),
);
const start = performance.now();
const prediction = estimate(rows, {
  text: "合成の入力文章で動作時間を測ります",
});
const inferenceMs = performance.now() - start;
const legacySource = await readFile(join(root, "tweets.js"), "utf8");
const legacy = JSON.parse(
  legacySource.slice(legacySource.indexOf("[")).replace(/;\s*$/, ""),
);
const legacyIds = new Set(legacy.map((r) => (r.tweet || r).id_str));
let sourceCommittedAt = null;
try {
  sourceCommittedAt =
    execFileSync(
      "git",
      ["-C", root, "log", "-1", "--format=%cI", "--", "tweet-archive"],
      { encoding: "utf8" },
    ).trim() || null;
} catch {}
const audit = {
  sourceCommittedAt,
  legacyRootCount: legacy.length,
  legacyDifference: ids.filter((id) => !legacyIds.has(id)).length,
  unavailableMetrics: [
    "reply_count",
    "quote_count",
    "impression_count",
    "view_count",
  ].filter((k) => !fields[k]),
  auditedAt: new Date().toISOString(),
  source: "tweet-archive/manifest.json",
  count: tweets.length,
  range: [
    new Date(dates[0]).toISOString(),
    new Date(dates.at(-1)).toISOString(),
  ],
  fields,
  duplicates: ids.length - new Set(ids).size,
  missing: {
    id: tweets.filter((t) => typeof t.id_str !== "string").length,
    date: tweets.length - dates.length,
    likes: tweets.filter((t) => t.favorite_count == null).length,
  },
  replyUnknown: rows.filter((r) => r.reply === null).length,
  quoteEvidence: rows.filter((r) => r.quote === true).length,
  quoteUnknown: rows.filter((r) => r.quote === null).length,
  replyEvidence: rows.reduce(
    (acc, r) => ((acc[r.replyEvidence] = (acc[r.replyEvidence] || 0) + 1), acc),
    {},
  ),
  archiveObservationTime: null,
  fixedHorizonAvailable: false,
  inferenceMs,
  eligible: prediction.total,
  limitations: [
    "取得日時が元アーカイブに存在しない",
    "分類修正は時点不明。時系列検証の特徴から除外",
    "本文が類似する投稿による漏洩を避けるため重複を除外",
    "実績の幅は未校正。区間精度は提供しない",
  ],
};
const evaluationStart = performance.now();
const evaluation = backtest(rows);
audit.evaluationMs = performance.now() - evaluationStart;
audit.deletedExcluded = (deleted.deletedIds || []).length;
await mkdir(join(root, "tracking"), { recursive: true });
await writeFile(
  join(root, "tracking/archive-audit.json"),
  JSON.stringify(audit, null, 2) + "\n",
);
await writeFile(
  join(root, "tracking/snapshot-evaluation.json"),
  JSON.stringify(evaluation, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    status: "saved-private",
    audit: "tracking/archive-audit.json",
    evaluation: "tracking/snapshot-evaluation.json",
  }),
);
