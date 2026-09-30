import { finiteMetric, median } from "./prediction.mjs";
export const HOUR = 3600000,
  DAY = 24 * HOUR;
export const HORIZONS = {
  hour1: { ms: HOUR, tolerance: 30 * 60000 },
  hour24: { ms: DAY, tolerance: 2 * HOUR },
  day7: { ms: 7 * DAY, tolerance: 2 * HOUR },
};
export const METRICS = ["likes", "reposts", "replies", "quotes", "views"];
export function postUrl(value) {
  const u = new URL(value);
  if (
    !["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(
      u.hostname,
    ) ||
    u.protocol !== "https:"
  )
    throw new Error(
      "https://x.com/アカウント/status/投稿ID を入力してください",
    );
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
  if (!m) throw new Error("投稿URLの形式を確認してください");
  return {
    id: m[2],
    account: m[1].toLowerCase(),
    url: `https://x.com/${m[1]}/status/${m[2]}`,
  };
}
export function active(post, now = Date.now()) {
  const age = now - Date.parse(post.createdAt);
  return (
    post.verified === true &&
    post.reply === false &&
    post.repost === false &&
    !post.paused &&
    age >= 0 &&
    age <= 7 * DAY
  );
}
export function due(post, snapshots, now = Date.now()) {
  const last = snapshots.filter((s) => s.id === post.id).at(-1);
  return (
    active(post, now) && (!last || now - Date.parse(last.observedAt) >= HOUR)
  );
}
export function snapshot(
  post,
  observation,
  runId,
  observedAt = new Date().toISOString(),
) {
  const elapsedMs = Date.parse(observedAt) - Date.parse(post.createdAt);
  if (!runId || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new Error("取得日時・投稿日時・実行IDが不正です");
  const success = observation.status === "success";
  return {
    id: String(post.id),
    url: post.url,
    createdAt: post.createdAt,
    runId,
    observedAt,
    elapsedMs,
    source: observation.source || "manual",
    status: success ? "success" : "failure",
    reason: observation.reason || null,
    metrics: Object.fromEntries(
      METRICS.map((k) => [
        k,
        success ? finiteMetric(observation.metrics?.[k]) : null,
      ]),
    ),
    raw: success ? observation.raw || {} : {},
    approximate: success ? observation.approximate || {} : {},
  };
}
export function appendSnapshot(state, s) {
  if (state.snapshots.some((x) => x.id === s.id && x.runId === s.runId))
    return false;
  state.snapshots.push(s);
  state.revision = (state.revision || 0) + 1;
  return true;
}
export function horizon(snapshots, id, key, availableAt = Infinity) {
  const h = HORIZONS[key];
  if (!h) throw new Error("不明な比較時点");
  return (
    snapshots
      .filter(
        (s) =>
          s.id === id &&
          s.status === "success" &&
          s.metrics.likes !== null &&
          !s.approximate?.likes &&
          Date.parse(s.observedAt) <= availableAt &&
          Math.abs(s.elapsedMs - h.ms) <= h.tolerance,
      )
      .sort(
        (a, b) =>
          Math.abs(a.elapsedMs - h.ms) - Math.abs(b.elapsedMs - h.ms) ||
          a.observedAt.localeCompare(b.observedAt),
      )[0] || null
  );
}
export function deltas(snapshots, id) {
  const a = snapshots
    .filter((s) => s.id === id)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  let previous = null;
  return a.map((s) => {
    const delta = Object.fromEntries(
      METRICS.map((k) => [
        k,
        s.status === "success" &&
        previous &&
        s.metrics[k] !== null &&
        previous.metrics[k] !== null &&
        !s.approximate?.[k] &&
        !previous.approximate?.[k]
          ? s.metrics[k] - previous.metrics[k]
          : null,
      ]),
    );
    const intervalMs = previous
      ? Date.parse(s.observedAt) - Date.parse(previous.observedAt)
      : null;
    if (s.status === "success") previous = s;
    return { ...s, delta, intervalMs };
  });
}
export function parseCount(display) {
  const raw = String(display || "").trim();
  const m = raw.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*(万|億|[KMB])?$/i);
  if (!m) return { value: null, raw, approximate: false };
  const factor =
    { 万: 1e4, 億: 1e8, k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1;
  return {
    value: Number(m[1]) * factor,
    raw,
    approximate: Boolean(m[2] || m[1].includes(".")),
  };
}
export function growthEstimate(
  state,
  postId,
  target = "hour24",
  at = Date.now(),
) {
  const post = state.posts.find((p) => p.id === postId),
    early = horizon(state.snapshots, postId, "hour1", at);
  if (!post || !early || !["hour24", "day7"].includes(target))
    return { value: null, reason: "予測時点までの1時間観測が不足しています" };
  const ratios = [];
  for (const p of state.posts) {
    if (
      p.id === postId ||
      Date.parse(p.createdAt) >= Date.parse(post.createdAt) ||
      p.reply !== false ||
      p.repost !== false ||
      !p.verified
    )
      continue;
    const start = horizon(
        state.snapshots,
        p.id,
        "hour1",
        Date.parse(early.observedAt),
      ),
      end = horizon(
        state.snapshots,
        p.id,
        target,
        Math.min(at, Date.parse(early.observedAt)),
      );
    if (start && end && start.metrics.likes > 0)
      ratios.push(end.metrics.likes / start.metrics.likes);
  }
  return {
    value:
      ratios.length >= 5
        ? Math.round(early.metrics.likes * median(ratios))
        : null,
    count: ratios.length,
    target,
    inputObservedAt: early.observedAt,
    inputLikes: early.metrics.likes,
    reason: ratios.length < 5 ? "固定時点の完了履歴が5件未満です" : null,
    modelVersion: "early-ratio-v1",
    spreadLabel: "初動モデルは投稿前モデルと別。未検証の参考推定",
  };
}
export function emptyState() {
  return {
    schemaVersion: 1,
    revision: 0,
    posts: [],
    snapshots: [],
    predictions: [],
    discovery: [],
  };
}
// Exact horizon labels can replace snapshot labels only when real observations exist.
export function fixedRows(state, key, availableAt = Infinity) {
  return state.posts.flatMap((p) => {
    const observation = horizon(state.snapshots, p.id, key, availableAt);
    if (!p.text || !observation || p.verified !== true) return [];
    return [
      {
        id: p.id,
        text: p.text,
        date: p.createdAt,
        reply: p.reply,
        repost: p.repost,
        quote: p.quote,
        likes: observation.metrics.likes,
        labelObservedAt: observation.observedAt,
        topic: p.topic,
        postStyle: p.postStyle,
      },
    ];
  });
}
export function growthBacktest(state, target = "hour24") {
  const posts = [...state.posts].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    split = Math.floor(posts.length * 0.8);
  function evaluate(sample) {
    const pairs = [];
    for (const p of sample) {
      const early = horizon(state.snapshots, p.id, "hour1"),
        actual = horizon(state.snapshots, p.id, target);
      if (!early || !actual) continue;
      const prediction = growthEstimate(
        state,
        p.id,
        target,
        Date.parse(early.observedAt),
      );
      if (prediction.value !== null)
        pairs.push([prediction.value, actual.metrics.likes]);
    }
    return {
      n: pairs.length,
      mae: pairs.length
        ? pairs.reduce((s, [p, y]) => s + Math.abs(p - y), 0) / pairs.length
        : null,
      log1pMAE: pairs.length
        ? pairs.reduce(
            (s, [p, y]) => s + Math.abs(Math.log1p(p) - Math.log1p(y)),
            0,
          ) / pairs.length
        : null,
    };
  }
  return {
    modelVersion: "early-ratio-v1",
    target,
    validation: evaluate(posts.slice(Math.floor(posts.length * 0.6), split)),
    test: evaluate(posts.slice(split)),
    interval: {
      coverage: null,
      width: null,
      reason: "初動モデルの区間は未校正",
    },
    method:
      "投稿前モデルとは別。過去投稿の完了履歴を1時間観測時点までで制限。最終20%はモデル選択に使わない",
  };
}
export function recordEarlyPredictions(state, id, asOf = Date.now()) {
  state.predictions ||= [];
  for (const target of ["hour24", "day7"]) {
    if (
      state.predictions.some(
        (p) => p.kind === "early" && p.postId === id && p.targetKey === target,
      )
    )
      continue;
    const p = growthEstimate(state, id, target, asOf);
    if (p.value === null) continue;
    state.predictions.push({
      ...p,
      kind: "early",
      postId: id,
      targetKey: target,
      predictionId: `early:${id}:${target}`,
      predictedAt: new Date(asOf).toISOString(),
      sourceRevision: state.revision,
    });
  }
}
