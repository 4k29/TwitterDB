// Results contain only capability/availability, never post text, cookies or DOM.
import { openBrowser, readPost, discover } from "./browser-source.mjs";
const [account, ...urls] = process.argv.slice(2);
if (!account || !urls.length)
  throw new Error(
    "Usage: node tools/probe-browser.mjs account https://x.com/account/status/id ...",
  );
const { browser, context } = await openBrowser({
  storageState: process.env.X_STORAGE_STATE,
});
try {
  for (const url of urls.slice(0, 3))
    for (let repeat = 0; repeat < 2; repeat++) {
      const r = await readPost(context, url, account);
      console.log(
        JSON.stringify({
          repeat,
          status: r.status,
          reason: r.reason,
          availableMetrics: Object.keys(r.metrics || {}).filter(
            (k) => r.metrics[k] !== null,
          ),
          approximate: r.approximate || {},
        }),
      );
    }
  const d = await discover(context, account);
  console.log(
    JSON.stringify({
      discovery: d.status,
      reason: d.reason,
      count: d.urls.length,
    }),
  );
} finally {
  await browser.close();
}
