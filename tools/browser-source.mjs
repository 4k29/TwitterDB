import { parseCount, postUrl } from "../lib/tracking.mjs";
export async function openBrowser({
  storageState,
  executablePath = process.env.CHROMIUM_PATH,
} = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    proxy: process.env.HTTPS_PROXY
      ? { server: process.env.HTTPS_PROXY }
      : undefined,
  });
  try {
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      locale: "en-US",
    });
    return { browser, context };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
export async function readPost(context, url, expectedAccount) {
  const parsed = postUrl(url);
  let page;
  try {
    page = await context.newPage();
    await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    // One bounded wait; no CAPTCHA, access-control bypass, hidden API or network scraping.
    await page.locator("article").first().waitFor({ timeout: 12000 });
    const articles = page.locator("article");
    for (let i = 0; i < (await articles.count()); i++) {
      const a = articles.nth(i);
      const times = a.locator("a:has(time)");
      let identity = null,
        createdAt = null;
      for (let j = 0; j < (await times.count()); j++) {
        const href = await times.nth(j).getAttribute("href");
        try {
          const p = postUrl(new URL(href, "https://x.com").href);
          if (p.id === parsed.id) {
            identity = p;
            createdAt = await times
              .nth(j)
              .locator("time")
              .getAttribute("datetime");
            break;
          }
        } catch {}
      }
      if (!identity) continue;
      if (identity.account !== expectedAccount.toLowerCase())
        return {
          status: "failure",
          reason: "owner_mismatch",
          source: "browser-visible",
        };

      const metrics = {},
        raw = {},
        approximate = {};
      for (const [key, selector] of Object.entries({
        likes: '[data-testid="like"], [data-testid="unlike"]',
        reposts: '[data-testid="retweet"], [data-testid="unretweet"]',
        replies: '[data-testid="reply"]',
        views: 'a[href$="/analytics"]',
      })) {
        const control = a.locator(selector).first();
        let display = "";
        if ((await control.count()) && (await control.isVisible()))
          display = (await control.innerText()).trim();
        // Empty icon labels do NOT establish zero.
        const result = parseCount(display);
        metrics[key] = result.value;
        raw[key] = result.raw;
        approximate[key] = result.approximate;
      }
      metrics.quotes = null;
      const replyContext = a.locator('[data-testid="replyingTo"]').first(),
        socialContext = a.locator('[data-testid="socialContext"]').first();
      const reply =
        (await replyContext.count()) && (await replyContext.isVisible())
          ? true
          : null;
      const social =
        (await socialContext.count()) && (await socialContext.isVisible())
          ? await socialContext.innerText()
          : "";
      return {
        status: Object.values(metrics).some((v) => v !== null)
          ? "success"
          : "failure",
        reason: Object.values(metrics).some((v) => v !== null)
          ? null
          : "no_visible_metrics",
        source: "browser-visible",
        id: identity.id,
        account: identity.account,
        createdAt,
        reply,
        repost: /reposted|リポストしました/.test(social) ? true : null,
        text: await a
          .locator('[data-testid="tweetText"]')
          .first()
          .innerText()
          .catch(() => ""),
        metrics,
        raw,
        approximate,
      };
    }
    return {
      status: "failure",
      reason: "post_identity_unverified",
      source: "browser-visible",
    };
  } catch (error) {
    return {
      status: "failure",
      reason:
        error.name === "TimeoutError"
          ? "page_timeout_or_login_required"
          : "browser_load_failed",
      source: "browser-visible",
    };
  } finally {
    await page?.close().catch(() => {});
  }
}
export async function discover(context, account) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) throw new Error("Invalid account");
  let page;
  try {
    page = await context.newPage();
    await page.goto(`https://x.com/${account}`, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await page.locator("article").first().waitFor({ timeout: 12000 });
    const links = await page
      .locator("article a:has(time)")
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().width > 0)
          .map((n) => n.href),
      );
    return {
      status: "success",
      urls: [...new Set(links)].filter((url) => {
        try {
          return postUrl(url).account === account.toLowerCase();
        } catch {
          return false;
        }
      }),
      reason: null,
    };
  } catch {
    return {
      status: "failure",
      urls: [],
      reason: "profile_unavailable_or_login_required",
    };
  } finally {
    await page?.close().catch(() => {});
  }
}
