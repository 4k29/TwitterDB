// Synthetic browser-only fixtures. Never loads a real archive or logs a token.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { emptyState } from "../lib/tracking.mjs";
import { readPost, discover } from "../tools/browser-source.mjs";
const root = resolve(import.meta.dirname, ".."),
  now = Date.now();
let state = emptyState(),
  commit = "synthetic-v1",
  writes = 0;
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(root + "/")) throw new Error();
    const buf = await readFile(path);
    res.setHeader(
      "Content-Type",
      {
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".html": "text/html",
        ".css": "text/css",
      }[extname(path)] || "text/plain",
    );
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
});
try {
  const unauth = await browser.newPage();
  await unauth.goto(base + "/analytics/prediction.html");
  await unauth
    .getByText(
      "非公開データ用の認証が必要です。投稿DBの同期設定で登録してください。",
      { exact: true },
    )
    .waitFor();
  assert.equal(await unauth.locator("#predict").isDisabled(), true);
  await unauth.close();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "twitterdb:github-token:v1",
      "synthetic-not-a-credential",
    ),
  );
  const encode = (value) => gzipSync(JSON.stringify(value)).toString("base64");
  const raw = Array.from({ length: 40 }, (_, i) => ({
    tweet: {
      id_str: String(1000 + i),
      full_text: `合成 ${String.fromCodePoint(0x4e00 + i)}${String.fromCodePoint(0x5000 + i)}${i * i} 投稿の検証`,
      created_at: new Date(now - (50 - i) * 86400000).toISOString(),
      favorite_count: i,
      in_reply_to_status_id_str: null,
    },
  }));
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const p = url.pathname;
    if (p.endsWith("/contents/tracking/state.json")) {
      if (req.method() === "PUT") {
        state = JSON.parse(Buffer.from(req.postDataJSON().content, "base64"));
        writes++;
        return route.fulfill({ json: { content: { sha: "next" } } });
      }
      return route.fulfill({
        json: {
          sha: "state",
          content: Buffer.from(JSON.stringify(state)).toString("base64"),
        },
      });
    }
    if (p.includes("/commits/"))
      return route.fulfill({
        json: {
          sha: commit,
          commit: { committer: { date: new Date(now).toISOString() } },
        },
      });
    if (p.endsWith("/contents/tweet-archive/manifest.json"))
      return route.fulfill({
        json: { encoding: "gzip-base64", parts: ["part001.txt"] },
      });
    if (p.endsWith("/contents/tweet-archive/part001.txt"))
      return route.fulfill({
        body: gzipSync(
          "window.YTD.tweets.part0 = " + JSON.stringify(raw) + ";",
        ).toString("base64"),
      });
    if (p.endsWith("/contents/analytics/categories.js"))
      return route.fulfill({
        body:
          "window.CATEGORIES_DATA_GZIP=" +
          JSON.stringify(
            encode({
              subjects: ["合成"],
              topics: ["合成"],
              postStyles: ["合成"],
              rows: raw.map((r, i) => [r.tweet.id_str, 0, 0, 0]),
            }),
          ) +
          ";",
      });
    if (p.endsWith("/contents/analytics/corrections.json"))
      return route.fulfill({ json: { corrections: [] } });
    if (p.endsWith("/contents/deleted.json"))
      return route.fulfill({ json: { deletedIds: [] } });
    return route.fulfill({
      status: 404,
      json: { message: "synthetic missing" },
    });
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/analytics/prediction.html");
  await page.waitForFunction(
    () => !document.getElementById("predict").disabled,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page
    .locator("#draft")
    .fill("<img src=x onerror=alert(1)> 合成投稿の検証");
  await page.locator("#predict").click();
  await page.locator("#prediction .number").waitFor();
  assert.equal(await page.locator("#prediction img").count(), 0);
  await page.locator("#keepPrediction").click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("投稿案・予測"),
  );
  assert.equal(state.predictions.length, 1);
  await page.locator("#draft").fill("別の合成投稿");
  assert.equal(await page.locator("#keepPrediction").isDisabled(), true);
  await page
    .locator("#url")
    .fill("https://x.com/p_horeer/status/9000000000000000001");
  const created = new Date(now - 3600000),
    local = new Date(created.getTime() - created.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  await page.locator("#created").fill(local);
  await page.locator("#postText").fill("実際の合成本文");
  await page.locator("#type").selectOption("original");
  assert.equal(await page.locator("#type").inputValue(), "original");
  await page.locator("#type").selectOption("quote");
  await page.locator("#ownership").check();
  await page.locator("#registerForm button").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".post").length === 1,
  );
  assert.equal(state.posts[0].quote, true);
  await page.locator("#metric-9000000000000000001-likes").fill("0");
  await page
    .getByRole("button", { name: "手動記録を保存", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("実際の取得時刻"),
  );
  assert.equal(state.snapshots[0].metrics.likes, 0);
  assert.equal(state.snapshots[0].metrics.views, null);
  await page
    .getByRole("button", { name: "取得できなかったことを記録", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.includes("取得失敗を保存"),
  );
  assert.equal(state.snapshots[1].metrics.likes, null);
  await page.getByRole("button", { name: "停止する", exact: true }).click();
  await page.getByRole("button", { name: "再開する", exact: true }).waitFor();
  assert.equal(state.posts[0].paused, true);
  await page.getByRole("button", { name: "再開する", exact: true }).click();
  await page.getByRole("button", { name: "停止する", exact: true }).waitFor();
  assert.equal(state.posts[0].paused, false);
  await page.locator("#evaluate").click();
  await page.waitForFunction(() =>
    document.getElementById("evaluation").textContent.includes("log1pMAE"),
  );
  commit = "synthetic-v2";
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () =>
      !document.getElementById("predict").disabled &&
      document.getElementById("status").textContent.startsWith("読み込み完了"),
  );
  await page.locator("#predict").click();
  await page.waitForFunction(() =>
    document.getElementById("prediction").textContent.includes("synthetic-v2"),
  );
  await page.locator("#target").selectOption("hour24");
  await page.locator("#predict").click();
  await page.waitForFunction(() =>
    document.querySelector("#prediction .number").textContent.includes("不足"),
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert(writes >= 5);
  // Real DOM-reading adapter against rendered synthetic X-like pages.
  const source = await browser.newContext();
  await source.route("https://x.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<article><a href="/p_horeer/status/1"><time datetime="2026-09-30T00:00:00Z">date</time></a><div data-testid="tweetText">synthetic</div><button data-testid="like">1.2万</button><button data-testid="reply">0</button><button data-testid="retweet"></button></article>',
    }),
  );
  const observation = await readPost(
    source,
    "https://x.com/p_horeer/status/1",
    "p_horeer",
  );
  assert.equal(observation.status, "success");
  assert.equal(observation.metrics.likes, 12000);
  assert.equal(observation.approximate.likes, true);
  assert.equal(observation.metrics.replies, 0);
  assert.equal(observation.metrics.reposts, null);
  assert.equal(observation.reply, null);
  const mismatch = await readPost(
    source,
    "https://x.com/p_horeer/status/1",
    "other",
  );
  assert.equal(mismatch.reason, "owner_mismatch");
  assert.equal((await discover(source, "p_horeer")).urls.length, 1);
  console.log(
    "PASS: unauthenticated, synthetic private API, mobile, escaped text, worker prediction, manual register/zero/failure/pause/resume, evaluation, cache invalidation, fixed horizon empty, visible DOM/owner/discovery",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
