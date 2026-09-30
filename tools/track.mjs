import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "./private-directory.mjs";
import {
  emptyState,
  due,
  active,
  snapshot,
  appendSnapshot,
  postUrl,
  DAY,
  recordEarlyPredictions,
} from "../lib/tracking.mjs";
import { openBrowser, readPost, discover } from "./browser-source.mjs";
const directory = await privateDirectory(process.env.TWITTERDB_DATA_DIR);
const dir = join(resolve(directory), "tracking");
await mkdir(dir, { recursive: true });
const lock = join(dir, ".runner.lock");
try {
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  throw new Error(
    "追跡処理が実行中です。停止を確認してから tracking/.runner.lock を除去してください",
  );
}
let browser;
try {
  const path = join(dir, "state.json");
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = emptyState();
  }
  if (state.schemaVersion !== 1) throw new Error("Unsupported tracking schema");
  const save = async () => {
    const tmp = join(dir, ".state-" + process.pid + ".tmp");
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, path);
  };
  const account = process.env.X_ACCOUNT || "p_horeer";
  const runId = process.env.TRACKING_RUN_ID || randomUUID();
  let context;
  try {
    const opened = await openBrowser({
      storageState: process.env.X_STORAGE_STATE,
    });
    browser = opened.browser;
    context = opened.context;
  } catch {
    for (const p of state.posts
      .filter(
        (p) =>
          due(p, state.snapshots) &&
          p.account.toLowerCase() === account.toLowerCase(),
      )
      .slice(0, 10))
      appendSnapshot(
        state,
        snapshot(
          p,
          {
            status: "failure",
            source: "browser-visible",
            reason: "browser_start_failed",
          },
          runId,
        ),
      );
    await save();
    throw new Error(
      "ブラウザを起動できませんでした。対象投稿の取得失敗を保存しました",
    );
  }
  if (process.argv.includes("--discover")) {
    const d = await discover(context, account);
    state.discovery.push({
      observedAt: new Date().toISOString(),
      status: d.status,
      reason: d.reason,
      count: d.urls.length,
    });
    for (const url of d.urls.slice(0, 10)) {
      const parsed = postUrl(url);
      if (state.posts.some((p) => p.id === parsed.id)) continue;
      const r = await readPost(context, url, account);
      const age = Date.now() - Date.parse(r.createdAt);
      if (r.account === account.toLowerCase() && age >= 0 && age <= 7 * DAY)
        state.posts.push({
          ...parsed,
          createdAt: r.createdAt,
          text: r.text || "",
          verified: true,
          reply: r.reply,
          repost: r.repost,
          paused: false,
          verificationSource: "browser-visible",
          discoveredAt: new Date().toISOString(),
        });
    }
    await save();
  }
  // Limit each run; missing hours remain missing. Posts of uncertain type remain pending.
  for (const p of state.posts
    .filter((p) => due(p, state.snapshots))
    .slice(0, 10)) {
    if (
      !due(p, state.snapshots) ||
      p.account.toLowerCase() !== account.toLowerCase()
    )
      continue;
    if (state.snapshots.some((s) => s.id === p.id && s.runId === runId))
      continue;
    const r = await readPost(context, p.url, account);
    if (r.reply === true || r.repost === true) {
      p.reply = r.reply === true ? true : p.reply;
      p.repost = r.repost === true ? true : p.repost;
    }
    if (
      r.account === account.toLowerCase() &&
      Number.isFinite(Date.parse(r.createdAt))
    ) {
      p.createdAt = new Date(r.createdAt).toISOString();
      if (Date.now() - Date.parse(p.createdAt) > 7 * DAY) {
        r.status = "failure";
        r.reason = "outside_tracking_window";
      }
    }
    const observedAt = new Date().toISOString();
    // Actual fetch may pass the 7-day boundary: retain it and stop further collection.
    appendSnapshot(state, snapshot(p, r, runId, observedAt));
    recordEarlyPredictions(state, p.id, Date.parse(observedAt));
    await save();
  }
  console.log(
    JSON.stringify({
      status: "complete",
      active: state.posts.filter((p) => active(p)).length,
      snapshots: state.snapshots.length,
    }),
  );
} finally {
  if (browser) await browser.close();
  await unlink(lock);
}
