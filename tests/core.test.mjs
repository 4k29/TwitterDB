import test from "node:test";
import assert from "node:assert/strict";
import {
  replyState,
  archiveRows,
  estimate,
  trainingRows,
  backtest,
  cacheKey,
  finiteMetric,
} from "../lib/prediction.mjs";
import {
  emptyState,
  active,
  due,
  snapshot,
  appendSnapshot,
  horizon,
  deltas,
  parseCount,
  postUrl,
  HOUR,
  DAY,
  growthEstimate,
  fixedRows,
  growthBacktest,
  recordEarlyPredictions,
} from "../lib/tracking.mjs";
const t0 = Date.parse("2026-01-01T00:00:00Z");
const post = (id = "1", offset = 0) => ({
  id,
  account: "own",
  url: `https://x.com/own/status/${id}`,
  createdAt: new Date(t0 + offset).toISOString(),
  verified: true,
  reply: false,
  repost: false,
});
const sample = (p, n, elapsed, run = "run" + elapsed) =>
  snapshot(
    p,
    { status: "success", metrics: { likes: n } },
    run,
    new Date(Date.parse(p.createdAt) + elapsed).toISOString(),
  );
test("structured replies take priority; quotes included; leading @ does not decide", () => {
  assert.equal(replyState({ full_text: "@someone hello" }), null);
  assert.equal(
    replyState({
      in_reply_to_status_id_str: null,
      full_text: "@someone hello",
    }),
    false,
  );
  assert.equal(replyState({ in_reply_to_status_id_str: "10" }), true);
  const raw = [
    {
      id_str: "1",
      created_at: new Date(t0).toISOString(),
      full_text: "通常の投稿",
      favorite_count: 0,
      in_reply_to_status_id_str: null,
      quoted_status_id_str: "12",
    },
    {
      id_str: "2",
      created_at: new Date(t0).toISOString(),
      full_text: "返信文章",
      favorite_count: 3,
      in_reply_to_status_id_str: "1",
    },
    {
      id_str: "3",
      created_at: new Date(t0).toISOString(),
      full_text: "RT @x abc",
      favorite_count: 4,
      in_reply_to_status_id_str: null,
    },
  ];
  const rows = archiveRows(raw);
  assert.equal(rows[0].quote, true);
  assert.deepEqual(
    trainingRows(rows).map((x) => x.id),
    ["1"],
  );
  assert.equal(archiveRows([{ ...raw[0], id_str: 123 }]).length, 0);
});
test("7 days, stopped, replies/reposts/unknown and future dates", () => {
  const p = post();
  assert.equal(active(p, t0), true);
  assert.equal(active(p, t0 + 7 * DAY), true);
  assert.equal(active(p, t0 + 7 * DAY + 1), false);
  assert.equal(active(p, t0 - 1), false);
  for (const fields of [
    { reply: true },
    { reply: null },
    { repost: true },
    { repost: null },
    { verified: false },
    { paused: true },
  ])
    assert.equal(active({ ...p, ...fields }, t0), false);
});
test("missing differs from zero; failed fetch never zeroes previous success; decreases preserved", () => {
  const p = post(),
    state = emptyState();
  const s = sample(p, 0, HOUR, "one");
  assert.equal(s.metrics.likes, 0);
  assert.equal(s.metrics.views, null);
  assert.equal(appendSnapshot(state, s), true);
  assert.equal(appendSnapshot(state, s), false);
  appendSnapshot(state, sample(p, 10, 2 * HOUR));
  appendSnapshot(
    state,
    snapshot(
      p,
      { status: "failure", reason: "auth", metrics: { likes: 0 } },
      "fail",
      new Date(t0 + 3 * HOUR).toISOString(),
    ),
  );
  appendSnapshot(state, sample(p, 7, 4 * HOUR));
  const history = deltas(state.snapshots, p.id);
  assert.equal(history[2].metrics.likes, null);
  assert.equal(history[3].delta.likes, -3);
  assert.equal(history[3].intervalMs, 2 * HOUR);
  assert.equal(state.snapshots[1].metrics.likes, 10);
});
test("exact horizon tolerances, no backfill and approximate values excluded", () => {
  const p = post(),
    s = [
      sample(p, 3, HOUR - 31 * 60000),
      sample(p, 8, 24 * HOUR + 2 * HOUR + 1),
    ];
  assert.equal(horizon(s, p.id, "hour1"), null);
  assert.equal(horizon(s, p.id, "hour24"), null);
  s.push(sample(p, 0, HOUR + 30 * 60000));
  assert.equal(horizon(s, p.id, "hour1").metrics.likes, 0);
  assert.equal(horizon(s, p.id, "hour1", t0 + HOUR), null);
  s.at(-1).approximate.likes = true;
  assert.equal(horizon(s, p.id, "hour1"), null);
  assert.equal(due(p, s, t0 + HOUR), false);
});
test("abbreviations are approximate, missing counts never zero", () => {
  assert.deepEqual(parseCount("1.2万"), {
    value: 12000,
    raw: "1.2万",
    approximate: true,
  });
  assert.equal(parseCount("1.2K").value, 1200);
  assert.equal(parseCount("1,234").approximate, false);
  assert.equal(parseCount("").value, null);
  assert.equal(parseCount("0").value, 0);
  assert.equal(finiteMetric(null), null);
  assert.equal(finiteMetric(""), null);
  assert.equal(
    postUrl("https://x.com/Own/status/9999999999999999999").id,
    "9999999999999999999",
  );
  assert.throws(() => postUrl("https://evil.com/own/status/1"));
  assert.throws(() => postUrl("http://x.com/own/status/1"));
});
const rows = Array.from({ length: 40 }, (_, i) => ({
  id: String(i + 1),
  text: `合成投稿 ${String.fromCodePoint(0x4e00 + i)}${String.fromCodePoint(0x5000 + i)}${String.fromCodePoint(0x5100 + i)} ${i * i}`,
  date: new Date(t0 + i * DAY).toISOString(),
  likes: i,
  reply: false,
  repost: false,
}));
test("future labels, self, duplicate and near duplicate excluded", () => {
  const past = rows.slice(0, 10),
    future = { ...rows[20], likes: 1e9 };
  const p = estimate(
    [...past, future],
    { text: rows[5].text },
    { cutoff: t0 + 10 * DAY, excludeId: rows[5].id, excludeText: rows[5].text },
  );
  assert(p.total <= 9);
  assert(!p.similar.some((s) => s.id === future.id || s.id === rows[5].id));
  assert.equal(
    trainingRows([
      ...rows,
      {
        ...rows[0],
        id: "different",
        date: new Date(t0 + 80 * DAY).toISOString(),
      },
    ]).length,
    trainingRows(rows).length,
  );
  const labelled = {
    ...rows[0],
    labelObservedAt: new Date(t0 + 2 * DAY).toISOString(),
  };
  assert.equal(trainingRows([labelled], t0 + DAY).length, 0);
  const result = backtest(rows);
  assert(result.trainCount === Math.floor(result.n * 0.6));
  assert(result.validation.period[1] < result.test.period[0]);
  assert.equal(result.predictionInterval, undefined);
  assert.equal(result.test.predictionInterval.coverage, null);
});
test("cache invalidation includes both source and algorithm", () => {
  assert.notEqual(cacheKey("a"), cacheKey("b"));
  assert.notEqual(cacheKey("a", "v1"), cacheKey("a", "v2"));
});
test("early model uses only completed past observations at early prediction time", () => {
  const state = emptyState();
  state.posts = Array.from({ length: 7 }, (_, i) =>
    post(String(i + 1), i * 2 * DAY),
  );
  for (const p of state.posts) {
    appendSnapshot(state, sample(p, 10, HOUR));
    appendSnapshot(state, sample(p, 20, DAY));
  }
  const target = state.posts.at(-1),
    at = Date.parse(target.createdAt) + HOUR;
  const a = growthEstimate(state, target.id, "hour24", at);
  assert.equal(a.value, 20);
  assert.equal(a.count, 6);
  appendSnapshot(state, sample(state.posts[0], 9999, 20 * DAY, "future"));
  assert.deepEqual(growthEstimate(state, target.id, "hour24", at), a);
  assert.equal(
    growthEstimate(state, target.id, "hour24", Date.parse(target.createdAt))
      .value,
    null,
  );
  assert.equal(growthBacktest(state).test.mae, 0);
  state.posts[0].text = "actual published synthetic text";
  assert.equal(fixedRows(state, "hour24", t0 + HOUR).length, 0);
  assert.equal(fixedRows(state, "hour24").length, 1);
});
test("final holdout labels cannot affect model selection or validation", () => {
  const a = backtest(rows),
    changed = rows.map((r, i) => (i >= 32 ? { ...r, likes: 1e9 } : r)),
    b = backtest(changed);
  assert.deepEqual(a.validation, b.validation);
  assert.equal(a.selectedStrategy, b.selectedStrategy);
  assert.notEqual(a.test.metrics.recent.mae, b.test.metrics.recent.mae);
});
test("full export schema absence differs from incomplete custom metadata", () => {
  assert.equal(
    replyState({
      full_text: "@name mention",
      edit_info: {},
      entities: {},
      retweeted: false,
    }),
    false,
  );
  assert.equal(replyState({ full_text: "@name mention" }), null);
  assert.equal(replyState({ in_reply_to_user_id: "123" }), true);
});
test("partial execution retains success and failure independently; next scheduled run respects last attempt", () => {
  const state = emptyState(),
    a = post("1"),
    b = post("2");
  state.posts = [a, b];
  appendSnapshot(state, sample(a, 10, HOUR, "same-run"));
  appendSnapshot(
    state,
    snapshot(
      b,
      { status: "failure", reason: "rate_limited" },
      "same-run",
      new Date(t0 + HOUR).toISOString(),
    ),
  );
  assert.equal(state.snapshots.length, 2);
  assert.equal(state.snapshots[0].metrics.likes, 10);
  assert.equal(state.snapshots[1].metrics.likes, null);
  assert.equal(due(b, state.snapshots, t0 + HOUR + 1), false);
  assert.equal(due(b, state.snapshots, t0 + 2 * HOUR), true);
});

test("early forecasts are recorded once and remain immutable after new history", () => {
  const state = emptyState();
  state.posts = Array.from({ length: 7 }, (_, i) =>
    post(String(i + 1), i * 2 * DAY),
  );
  for (const p of state.posts) {
    appendSnapshot(state, sample(p, 10, HOUR));
    appendSnapshot(state, sample(p, 20, DAY));
  }
  const target = state.posts.at(-1),
    asOf = Date.parse(target.createdAt) + HOUR;
  recordEarlyPredictions(state, target.id, asOf);
  const saved = structuredClone(state.predictions);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].targetKey, "hour24");
  assert.equal(saved[0].value, 20);
  appendSnapshot(state, sample(state.posts[0], 500, 23 * HOUR, "later-record"));
  recordEarlyPredictions(state, target.id, asOf + DAY);
  assert.deepEqual(state.predictions, saved);
});
