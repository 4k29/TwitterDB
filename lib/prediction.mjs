// No fitted vocabulary, labels or private records are shipped with this module.
export const MODEL_VERSION = "snapshot-bigram-v1";
export const finiteMetric = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
export function median(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
    : null;
}
export function normalized(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
export function grams(text) {
  const s = [...normalized(text)],
    result = new Set();
  for (let i = 0; i < s.length - 1; i++) result.add(s[i] + s[i + 1]);
  return result;
}
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return (2 * n) / (a.size + b.size);
}
export function replyState(t) {
  if (
    t.in_reply_to_status_id_str ||
    t.in_reply_to_status_id ||
    t.in_reply_to_user_id_str ||
    t.in_reply_to_user_id ||
    t.in_reply_to_screen_name
  )
    return true;
  if (
    Object.hasOwn(t, "in_reply_to_status_id_str") ||
    Object.hasOwn(t, "in_reply_to_status_id") ||
    Object.hasOwn(t, "in_reply_to_screen_name")
  )
    return false;
  // Full X export records omit reply keys for non-replies. Compact/custom records
  // without the export structure do not establish that absence contract.
  if (
    t.edit_info &&
    t.entities &&
    Object.hasOwn(t, "retweeted") &&
    Object.hasOwn(t, "full_text")
  )
    return false;
  return null;
}
export function archiveRows(raw, categories = new Map(), deleted = new Set()) {
  const map = new Map();
  for (const wrapper of raw) {
    const t = wrapper.tweet || wrapper,
      id = t.id_str;
    if (typeof id !== "string" || !/^\d+$/.test(id) || deleted.has(id))
      continue;
    const reply = replyState(t),
      repost = Boolean(
        t.retweeted_status || /^RT\s+@/i.test(t.full_text || ""),
      );
    const date = new Date(t.created_at).getTime();
    if (!Number.isFinite(date)) continue;
    map.set(id, {
      id,
      replyEvidence:
        reply === null
          ? "unknown"
          : t.in_reply_to_status_id_str ||
              t.in_reply_to_status_id ||
              t.in_reply_to_user_id_str ||
              t.in_reply_to_user_id ||
              t.in_reply_to_screen_name
            ? "reply-fields"
            : t.edit_info && t.entities && Object.hasOwn(t, "retweeted")
              ? "full-export-field-absence"
              : "explicit-empty-reply-fields",
      text: t.full_text || t.text || "",
      date: new Date(date).toISOString(),
      likes: finiteMetric(t.favorite_count),
      reply,
      repost,
      quote: [
        "quoted_status_id_str",
        "quoted_status_id",
        "is_quote_status",
      ].some((k) => Object.hasOwn(t, k))
        ? Boolean(
            t.quoted_status_id_str ||
              t.quoted_status_id ||
              t.is_quote_status === true ||
              t.is_quote_status === "true",
          )
        : null,
      ...categories.get(id),
    });
  }
  return [...map.values()];
}
const cleanedCache = new WeakMap(),
  gramCache = new WeakMap();
function rowGrams(row) {
  if (!gramCache.has(row)) gramCache.set(row, grams(row.text));
  return gramCache.get(row);
}
export function trainingRows(rows, cutoff = Infinity) {
  if (cleanedCache.has(rows))
    return cleanedCache
      .get(rows)
      .filter(
        (r) =>
          Date.parse(r.date) < cutoff &&
          (!r.labelObservedAt || Date.parse(r.labelObservedAt) <= cutoff),
      );
  // Keep the FIRST normalized text; later duplicates cannot enter a held-out fold.
  const ids = new Set(),
    texts = new Set(),
    earlier = [];
  const cleaned = [...rows]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .filter((r) => {
      const key = normalized(r.text),
        g = rowGrams(r),
        valid =
          r.reply === false &&
          !r.repost &&
          finiteMetric(r.likes) !== null &&
          key.length >= 2 &&
          !ids.has(r.id) &&
          !texts.has(key) &&
          !earlier.some((other) => similarity(other, g) >= 0.9);
      if (valid) {
        ids.add(r.id);
        texts.add(key);
        earlier.push(g);
      }
      return valid;
    });
  cleanedCache.set(rows, cleaned);
  return cleaned.filter(
    (r) =>
      Date.parse(r.date) < cutoff &&
      (!r.labelObservedAt || Date.parse(r.labelObservedAt) <= cutoff),
  );
}
export function estimate(
  rows,
  draft,
  {
    cutoff = Infinity,
    excludeId = "",
    excludeText = "",
    version = "",
    minCount = 5,
    strategy = "similar",
    target = "アーカイブ取得時点のいいね（観測経過時間は不明・混在）",
  } = {},
) {
  const q = grams(draft.text),
    key = normalized(excludeText);
  const pool = trainingRows(rows, cutoff).filter(
    (r) =>
      r.id !== excludeId && (!key || similarity(grams(key), rowGrams(r)) < 0.9),
  );
  const ranked = pool
    .map((r) => {
      const sim = similarity(q, rowGrams(r));
      const topic = Boolean(draft.topic && draft.topic === r.topic),
        style = Boolean(draft.postStyle && draft.postStyle === r.postStyle);
      return {
        ...r,
        similarity: sim,
        score: sim + 0.15 * Number(topic) + 0.08 * Number(style),
        reasons: [
          ...(sim > 0 ? ["日本語本文の2文字組が共通"] : []),
          ...(topic ? ["テーマが一致"] : []),
          ...(style ? ["投稿形式が一致"] : []),
        ],
      };
    })
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  const comparable = ranked
    .filter(
      (r) => r.similarity >= 0.12 || (draft.topic && draft.topic === r.topic),
    )
    .slice(0, 20);
  const recent = pool.slice(-100),
    same = pool
      .filter((r) => draft.topic && r.topic === draft.topic)
      .slice(-100);
  const reference =
    strategy === "recent"
      ? recent
      : comparable.length >= minCount
        ? comparable
        : same.length >= minCount
          ? same
          : recent;
  const kind =
    strategy === "recent"
      ? "recent"
      : comparable.length >= minCount
        ? "similar"
        : same.length >= minCount
          ? "category"
          : "recent";
  const values = reference.map((r) => r.likes).sort((a, b) => a - b);
  return {
    modelVersion: MODEL_VERSION,
    sourceVersion: version,
    target,
    value: values.length >= minCount ? median(values) : null,
    kind,
    count: values.length,
    total: pool.length,
    spread:
      values.length >= minCount
        ? [
            values[Math.floor((values.length - 1) * 0.1)],
            values[Math.ceil((values.length - 1) * 0.9)],
          ]
        : null,
    spreadLabel: "比較対象の実績の幅（10–90%点・予測区間ではありません）",
    similar: comparable.slice(0, 5),
    baselines: {
      recent: median(recent.map((r) => r.likes)),
      category:
        same.length >= minCount ? median(same.map((r) => r.likes)) : null,
    },
  };
}
export function cacheKey(sourceVersion, modelVersion = MODEL_VERSION) {
  return `${sourceVersion}:${modelVersion}`;
}
function scores(pairs) {
  if (!pairs.length) return { n: 0, mae: null, log1pMAE: null };
  return {
    n: pairs.length,
    mae: pairs.reduce((s, [p, y]) => s + Math.abs(p - y), 0) / pairs.length,
    log1pMAE:
      pairs.reduce(
        (s, [p, y]) => s + Math.abs(Math.log1p(p) - Math.log1p(y)),
        0,
      ) / pairs.length,
  };
}
export function backtest(rows) {
  const clean = trainingRows(rows),
    a = Math.floor(clean.length * 0.6),
    b = Math.floor(clean.length * 0.8);
  function fold(train, test) {
    const methods = { similar: [], recent: [], category: [] };
    let covered = 0,
      width = 0,
      spreadN = 0;
    for (const r of test) {
      // Future/corrected classifications cannot safely be used in a historical backtest.
      const p = estimate(
        train,
        { text: r.text },
        { cutoff: Date.parse(r.date), excludeId: r.id, excludeText: r.text },
      );
      if (p.value !== null) methods.similar.push([p.value, r.likes]);
      for (const k of ["recent", "category"])
        if (p.baselines[k] !== null) methods[k].push([p.baselines[k], r.likes]);
      if (p.spread) {
        spreadN++;
        covered += Number(r.likes >= p.spread[0] && r.likes <= p.spread[1]);
        width += p.spread[1] - p.spread[0];
      }
    }
    return {
      period: test.length ? [test[0].date, test.at(-1).date] : null,
      metrics: Object.fromEntries(
        Object.entries(methods).map(([k, v]) => [k, scores(v)]),
      ),
      historicalSpread: {
        n: spreadN,
        coverage: spreadN ? covered / spreadN : null,
        meanWidth: spreadN ? width / spreadN : null,
        label: "未校正の実績幅。予測区間ではない",
      },
      predictionInterval: {
        coverage: null,
        width: null,
        reason: "未校正のため提供しない",
      },
    };
  }
  // Algorithm is pre-specified. Final holdout never participates in selection/calibration.
  const validation = fold(clean.slice(0, a), clean.slice(a, b)),
    test = fold(clean.slice(0, b), clean.slice(b));
  const x = validation.metrics.similar,
    y = validation.metrics.recent;
  const selectedStrategy =
    x.n >= 20 && x.n === y.n && x.mae < y.mae && x.log1pMAE < y.log1pMAE
      ? "similar"
      : "recent";
  return {
    modelVersion: MODEL_VERSION,
    n: clean.length,
    trainCount: a,
    validation,
    test,
    selectedStrategy,
    classificationEvaluation:
      "後付け分類の時点が不明なため分類条件は検証から除外。分類中央値の検証は未実施",
    selection: "説明可能な参考推定。改善の保証なし。複雑なモデルは未採用",
  };
}
