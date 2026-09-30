import {
  archiveRows,
  MODEL_VERSION,
  cacheKey,
  finiteMetric,
} from "../lib/prediction.mjs";
import {
  postUrl,
  emptyState,
  active,
  snapshot,
  appendSnapshot,
  deltas,
  horizon,
  growthEstimate,
  DAY,
  HOUR,
  fixedRows,
  growthBacktest,
  recordEarlyPredictions,
} from "../lib/tracking.mjs";
import { readState, mutateState } from "../lib/private-tracking.mjs";
const $ = (id) => document.getElementById(id),
  client = window.PrivateTwitterDB;
let state = emptyState(),
  version = "",
  updatedAt = "",
  latest = null,
  busy = false;
const worker = new Worker("./prediction-worker.mjs", { type: "module" }),
  pending = new Map();
let seq = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (p) data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
};
worker.onerror = () => {
  for (const p of pending.values())
    p.reject(new Error("予測処理を起動できません"));
  pending.clear();
};
const compute = (data) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...data, id });
  });
function node(tag, text, parent) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  parent?.append(el);
  return el;
}
function message(text, error = false) {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
}
const fmt = (value) =>
  value === null || value === undefined
    ? "欠測"
    : new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(
        value,
      );
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
function link(url, text, parent) {
  const el = node("a", text, parent);
  el.href = url;
  el.target = "_blank";
  el.rel = "noopener";
  return el;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
  }
}
async function load() {
  if (!client?.getToken()) {
    message(
      "非公開データ用の認証が必要です。投稿DBの同期設定で登録してください。",
      true,
    );
    return;
  }
  message("アーカイブ・分類修正・削除状態・履歴を読み込んでいます…");
  latest = null;
  $("keepPrediction").disabled = true;
  const [raw, encoded, corrections, deleted, commit, tracking] =
    await Promise.all([
      client.archive(),
      client.assignment("analytics/categories.js"),
      client.json("analytics/corrections.json"),
      client.json("deleted.json"),
      client.api(`/commits/${client.BRANCH}`),
      readState(client),
    ]);
  const zipped = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const cats = JSON.parse(
    await new Response(
      new Blob([zipped]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );
  const categories = new Map(
    cats.rows.map(([id, s, p, f]) => [
      String(id),
      {
        subject: cats.subjects[s],
        topic: cats.topics[p],
        postStyle: cats.postStyles[f],
      },
    ]),
  );
  for (const c of corrections.corrections || [])
    categories.set(String(c.tweetId), {
      subject: c.subject,
      topic: c.topic,
      postStyle: c.postStyle,
    });
  const rows = archiveRows(
    raw,
    categories,
    new Set((deleted.deletedIds || []).map(String)),
  );
  version = commit.sha;
  updatedAt = commit.commit?.committer?.date || "";
  state = tracking.state;
  await compute({
    op: "init",
    datasets: {
      snapshot: rows,
      hour24: fixedRows(state, "hour24"),
      day7: fixedRows(state, "day7"),
    },
  });
  for (const [id, key] of [
    ["topics", "topic"],
    ["styles", "postStyle"],
  ]) {
    $(id).replaceChildren();
    for (const v of [
      ...new Set(rows.map((r) => r[key]).filter(Boolean)),
    ].sort()) {
      const option = node("option", undefined, $(id));
      option.value = v;
    }
  }
  $("predict").disabled = false;
  $("evaluate").disabled = false;
  renderPosts();
  message(
    `読み込み完了。アーカイブ ${raw.length}件／投稿日時 ${rows.length ? time(rows.reduce((a, b) => (a.date < b.date ? a : b)).date) : "不明"} ～ ${rows.length ? time(rows.reduce((a, b) => (a.date > b.date ? a : b)).date) : "不明"}。データ更新 ${time(updatedAt)}（リポジトリ更新であり反応取得日時ではありません）。モデル ${MODEL_VERSION}。`,
  );
}
function renderPrediction(p) {
  const box = $("prediction");
  box.replaceChildren();
  node(
    "p",
    p.value === null
      ? "比較可能な履歴が不足しています"
      : `参考いいね数：${fmt(Math.round(p.value))}`,
    box,
  ).className = "number";
  node(
    "p",
    `予測対象：${p.target}。比較対象 ${p.count}件／対象候補 ${p.total}件。採用方法：${{ similar: "類似投稿の中央値（実験的）", category: "同テーマ中央値（時系列精度は未検証）", recent: "最近100件以内の中央値" }[p.kind]}。時系列検証で改善が確認されるまでは実験的です。最近の中央値 ${fmt(p.baselines.recent)}、同テーマ中央値 ${fmt(p.baselines.category)}。`,
    box,
  );
  if (p.spread)
    node(
      "p",
      `${p.spreadLabel}：${fmt(p.spread[0])} ～ ${fmt(p.spread[1])}`,
      box,
    );
  node(
    "p",
    `更新 ${time(updatedAt)}。取得時点が不明、表示回数・フォロワー数・配信条件は判断材料に含めません。分類は任意入力で、未入力時は本文のみ。再計算キー ${cacheKey(version + ":" + state.revision)}`,
    box,
  );
  node(
    "p",
    `検証用期間のMAE：類似法 ${fmt(p.validation?.similar?.mae)}／最近中央値 ${fmt(p.validation?.recent?.mae)}。最近中央値に対するMAEとlog1p誤差の改善を検証期間で確認できた場合だけ類似法を代表値に採用します。`,
    box,
  );
  node("h3", "似た過去投稿", box);
  if (!p.similar.length) node("p", "十分に似た投稿はありません。", box);
  for (const r of p.similar) {
    const item = node("div", undefined, box);
    link(`https://x.com/i/web/status/${r.id}`, time(r.date), item);
    node("p", `${fmt(r.likes)}いいね・${r.reasons.join("、")}`, item);
    node("p", r.text, item).className = "similar";
  }
}
function chart(series, parent) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 800 160");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    "実際の経過時間に対するいいね数。点は実観測。欠測は補間しません",
  );
  const observed = series.filter(
      (s) => s.status === "success" && s.metrics.likes !== null,
    ),
    max = Math.max(1, ...observed.map((s) => s.metrics.likes));
  for (const s of observed) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", String(15 + (770 * s.elapsedMs) / (7 * DAY)));
    c.setAttribute("cy", String(145 - (125 * s.metrics.likes) / max));
    c.setAttribute("r", "3");
    c.setAttribute("fill", s.approximate?.likes ? "#ffba76" : "#b7bbff");
    const title = document.createElementNS(ns, "title");
    title.textContent = `${(s.elapsedMs / HOUR).toFixed(2)}時間 ${fmt(s.metrics.likes)}いいね`;
    c.append(title);
    svg.append(c);
  }
  parent.append(svg);
  node(
    "p",
    `横軸：0〜168時間／縦軸：0〜${fmt(max)}いいね。点のみ表示（概数は橙色）。`,
    parent,
  );
}
function renderPosts() {
  compute({
    op: "fixed",
    datasets: {
      hour24: fixedRows(state, "hour24"),
      day7: fixedRows(state, "day7"),
    },
  }).catch((e) => message(e.message, true));
  const box = $("posts");
  box.replaceChildren();
  $("savedPrediction").replaceChildren();
  const blank = node("option", "紐付けなし", $("savedPrediction"));
  blank.value = "";
  for (const p of (state.predictions || []).filter((p) => p.kind !== "early")) {
    const o = node(
      "option",
      `${time(p.predictedAt)}・${fmt(p.value)}いいね・${p.target}`,
      $("savedPrediction"),
    );
    o.value = p.predictionId;
  }
  if (!state.posts.length) node("p", "登録された投稿はありません。", box);
  for (const post of [...state.posts].reverse()) {
    const item = node("article", undefined, box);
    item.className = "post";
    link(post.url, post.id, item);
    const series = deltas(state.snapshots, post.id),
      last = series.at(-1),
      now = Date.now(),
      end = Date.parse(post.createdAt) + 7 * DAY;
    const label = post.paused
      ? "停止中"
      : active(post, now)
        ? "追跡中"
        : now > end
          ? "7日経過・終了"
          : "種別判定不能／対象外";
    node(
      "p",
      `${label}・${post.quote ? "引用投稿・" : ""}投稿 ${time(post.createdAt)}／終了 ${time(new Date(end).toISOString())}／最終取得 ${time(last?.observedAt)}／次回予定 ${active(post, now) ? time(new Date(Math.max(now, last ? Date.parse(last.observedAt) + HOUR : now)).toISOString()) + "（実行環境の設定が必要）" : "なし"}`,
      item,
    );
    if (post.reply === null || post.repost === null) {
      const label = node(
        "label",
        "元ページを確認して種別を確定（引用を含む。返信・リポストは除外）",
        item,
      );
      const select = node("select", undefined, item);
      label.htmlFor = "resolve-" + post.id;
      select.id = "resolve-" + post.id;
      for (const [value, text] of [
        ["unknown", "判定不能"],
        ["original", "通常投稿"],
        ["quote", "引用投稿"],
        ["reply", "返信（対象外）"],
        ["repost", "リポスト（対象外）"],
      ]) {
        const o = node("option", text, select);
        o.value = value;
      }
      const confirm = node("button", "確認した種別を保存", item);
      confirm.onclick = () =>
        action(async () => {
          const type = select.value;
          state = await mutateState(client, (s) => {
            const p = s.posts.find((p) => p.id === post.id);
            p.reply = type === "unknown" ? null : type === "reply";
            p.repost = type === "unknown" ? null : type === "repost";
            p.quote = type === "quote";
            p.verificationSource = "manual-visible";
          });
          renderPosts();
        });
    }
    const toggle = node("button", post.paused ? "再開する" : "停止する", item);
    toggle.type = "button";
    toggle.onclick = () =>
      action(async () => {
        state = await mutateState(client, (s) => {
          const p = s.posts.find((p) => p.id === post.id);
          p.paused = !post.paused;
        });
        renderPosts();
        message("追跡状態を保存しました");
      });
    chart(series, item);
    const wrap = node("div", undefined, item);
    wrap.className = "table-wrap";
    const table = node("table", undefined, wrap),
      head = node("tr", undefined, node("thead", undefined, table));
    for (const h of [
      "取得日時",
      "経過h",
      "状態／理由",
      "いいね",
      "増加（前回成功から）",
      "リポスト",
      "返信",
      "引用",
      "表示",
      "取得元",
    ])
      node("th", h, head);
    const body = node("tbody", undefined, table);
    for (const s of series) {
      const tr = node("tr", undefined, body);
      for (const v of [
        time(s.observedAt),
        (s.elapsedMs / HOUR).toFixed(2),
        s.status + (s.reason ? " / " + s.reason : ""),
        s.approximate?.likes
          ? `約${fmt(s.metrics.likes)} (${s.raw.likes})`
          : fmt(s.metrics.likes),
        fmt(s.delta.likes) +
          (s.intervalMs ? ` / ${(s.intervalMs / HOUR).toFixed(2)}h` : ""),
        ...["reposts", "replies", "quotes", "views"].map((k) =>
          s.approximate?.[k]
            ? `約${fmt(s.metrics[k])} (${s.raw[k]})`
            : fmt(s.metrics[k]),
        ),
        s.source,
      ])
        node("td", v, tr);
    }
    for (const [key, label] of [
      ["hour1", "1時間"],
      ["hour24", "24時間"],
      ["day7", "7日"],
    ]) {
      const h = horizon(state.snapshots, post.id, key);
      node(
        "p",
        `${label}：${h ? fmt(h.metrics.likes) + "いいね（実際 " + (h.elapsedMs / HOUR).toFixed(2) + "時間）" : "欠測（概数も比較から除外）"}`,
        item,
      );
    }
    const saved = (state.predictions || []).find(
      (p) => p.predictionId === post.predictionId,
    );
    if (saved) {
      const key = saved.target.startsWith("24時間")
        ? "hour24"
        : saved.target.startsWith("7日")
          ? "day7"
          : null;
      const actual = key ? horizon(state.snapshots, post.id, key) : null;
      node(
        "p",
        `投稿前予測：${fmt(saved.value)}／${saved.target}。${key ? (actual ? "実測 " + fmt(actual.metrics.likes) + "、絶対誤差 " + fmt(Math.abs(saved.value - actual.metrics.likes)) : "対応時点は欠測") : "アーカイブ取得時点と固定時点は異なるため、24時間・7日との差は精度指標にしません。"}`,
        item,
      );
    }
    for (const target of ["hour24", "day7"]) {
      const savedEarly = (state.predictions || []).find(
          (p) =>
            p.kind === "early" &&
            p.postId === post.id &&
            p.targetKey === target,
        ),
        p = savedEarly || growthEstimate(state, post.id, target);
      const observed = horizon(state.snapshots, post.id, target);
      node(
        "p",
        `初動から${target === "hour24" ? "24時間" : "7日"}の参考推定：${fmt(p.value)}（完了比較対象 ${p.count || 0}件）。${p.reason || "未検証の初動比率モデル。投稿前予測とは別。"}${savedEarly ? " 保存時点 " + time(savedEarly.predictedAt) + (observed ? "／実績 " + fmt(observed.metrics.likes) + "・絶対誤差 " + fmt(Math.abs(p.value - observed.metrics.likes)) : "／実績は欠測") : ""}`,
        item,
      );
    }
    const form = node("form", undefined, item),
      fields = {};
    node("h3", "いま確認した反応を手動記録", form);
    node(
      "p",
      "実際にページで見た値だけ入力してください。空欄は欠測、0はゼロ。1.2万等の概数も元表示ごと保存します。取得日時は保存時の実時刻です。",
      form,
    );
    for (const [key, title] of [
      ["likes", "いいね"],
      ["reposts", "リポスト"],
      ["replies", "返信"],
      ["quotes", "引用"],
      ["views", "表示回数"],
    ]) {
      const id = `metric-${post.id}-${key}`;
      const l = node("label", title, form);
      l.htmlFor = id;
      fields[key] = node("input", undefined, form);
      fields[key].id = id;
      fields[key].placeholder = "未取得";
    }
    const submit = node("button", "手動記録を保存", form);
    submit.disabled =
      now > end || post.reply !== false || post.repost !== false || post.paused;
    const failure = node("button", "取得できなかったことを記録", item);
    failure.type = "button";
    failure.disabled = !active(post);
    failure.onclick = () =>
      action(async () => {
        const s = snapshot(
          post,
          {
            status: "failure",
            source: "manual-visible",
            reason: "manual_load_failed",
          },
          crypto.randomUUID(),
        );
        state = await mutateState(client, (st) => {
          const current = st.posts.find((p) => p.id === post.id);
          if (!current || !active(current, Date.parse(s.observedAt)))
            throw new Error(
              "停止中・期限切れ・対象外の投稿には新しい手動記録を保存できません",
            );
          appendSnapshot(st, s);
          recordEarlyPredictions(st, post.id, Date.parse(s.observedAt));
        });
        renderPosts();
        message("取得失敗を保存しました。直前の成功実績は保持しています");
      });
    form.onsubmit = (e) => {
      e.preventDefault();
      action(async () => {
        const { parseCount } = await import("../lib/tracking.mjs");
        const metrics = {},
          raw = {},
          approximate = {};
        for (const k of Object.keys(fields)) {
          const p = parseCount(fields[k].value);
          if (fields[k].value.trim() && p.value === null)
            throw new Error("数値または 1.2万 / 1.2K の形式で入力してください");
          metrics[k] = p.value;
          raw[k] = p.raw;
          approximate[k] = p.approximate;
        }
        if (Object.values(metrics).every((v) => v === null))
          throw new Error("取得した指標を1つ以上入力してください");
        const s = snapshot(
          post,
          {
            status: "success",
            source: "manual-visible",
            metrics,
            raw,
            approximate,
          },
          crypto.randomUUID(),
        );
        state = await mutateState(client, (st) => {
          const current = st.posts.find((p) => p.id === post.id);
          if (!current || !active(current, Date.parse(s.observedAt)))
            throw new Error(
              "停止中・期限切れ・対象外の投稿には新しい手動記録を保存できません",
            );
          appendSnapshot(st, s);
          recordEarlyPredictions(st, post.id, Date.parse(s.observedAt));
        });
        renderPosts();
        message("実際の取得時刻で反応を保存しました");
      });
    };
  }
}
$("draftForm").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const draft = {
      text: $("draft").value.trim(),
      topic: $("topic").value.trim(),
      postStyle: $("style").value.trim(),
    };
    if (draft.text.length < 2)
      throw new Error("本文を2文字以上入力してください");
    $("predict").disabled = true;
    try {
      const p = await compute({
        op: "estimate",
        draft,
        version: version + ":" + state.revision,
        target: $("target").value,
        targetLabel:
          $("target").value === "snapshot"
            ? undefined
            : $("target").selectedOptions[0].textContent +
              "のいいね（時点の実測ラベルのみ）",
      });
      latest = {
        ...p,
        draft,
        predictedAt: new Date().toISOString(),
        predictionId: crypto.randomUUID(),
      };
      renderPrediction(p);
      $("keepPrediction").disabled = p.value === null;
    } finally {
      $("predict").disabled = false;
    }
  });
};
for (const id of ["draft", "topic", "style", "target"])
  $(id).oninput = () => {
    latest = null;
    $("keepPrediction").disabled = true;
  };
$("keepPrediction").onclick = () =>
  action(async () => {
    if (!latest) return;
    const saved = structuredClone(latest);
    delete saved.similar;
    state = await mutateState(client, (s) => {
      s.predictions ||= [];
      if (!s.predictions.some((p) => p.predictionId === saved.predictionId))
        s.predictions.push(saved);
    });
    renderPosts();
    message("投稿案・予測を非公開履歴に保存しました");
  });
$("registerForm").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const parsed = postUrl($("url").value);
    if (parsed.account !== "p_horeer")
      throw new Error("対象アカウント以外の投稿は登録できません");
    const createdAt = new Date($("created").value).toISOString(),
      age = Date.now() - Date.parse(createdAt);
    if (age < 0 || age > 7 * DAY)
      throw new Error("投稿日時から7日以内の投稿を登録してください");
    const type = $("type").value;
    if (["reply", "repost"].includes(type))
      throw new Error("返信・リポストは対象外です");
    const predictionId = $("savedPrediction").value,
      saved = state.predictions.find((p) => p.predictionId === predictionId);
    if (saved && Date.parse(saved.predictedAt) > Date.parse(createdAt))
      throw new Error("投稿後に保存した予測は投稿前予測に紐付けできません");
    const post = {
      ...parsed,
      createdAt,
      text: $("postText").value.trim(),
      verified: $("ownership").checked,
      reply: type === "unknown" ? null : false,
      repost: type === "unknown" ? null : false,
      quote: type === "quote",
      paused: false,
      verificationSource: "manual-visible",
      predictionId,
      registeredAt: new Date().toISOString(),
    };
    state = await mutateState(client, (s) => {
      if (s.posts.some((p) => p.id === post.id))
        throw new Error("この投稿は登録済みです");
      s.posts.push(post);
    });
    renderPosts();
    message("投稿を登録しました。種別判定不能の投稿は自動取得の対象外です");
  });
};
$("refresh").onclick = () => action(load);
$("evaluate").onclick = () =>
  action(async () => {
    $("evaluate").disabled = true;
    $("evaluation").textContent = "別スレッドで検証しています…";
    try {
      $("evaluation").textContent = JSON.stringify(
        {
          draft: await compute({ op: "backtest", target: $("target").value }),
          early24: growthBacktest(state, "hour24"),
          early7: growthBacktest(state, "day7"),
        },
        null,
        2,
      );
    } finally {
      $("evaluate").disabled = false;
    }
  });
action(load);
