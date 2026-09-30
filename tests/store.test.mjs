import test from "node:test";
import assert from "node:assert/strict";
import { readState, mutateState } from "../lib/private-tracking.mjs";
import { emptyState, appendSnapshot } from "../lib/tracking.mjs";
const err = (status) => Object.assign(new Error("synthetic error"), { status });
const file = (s) => ({
  sha: "s",
  content: Buffer.from(JSON.stringify(s)).toString("base64"),
});
test("404 starts empty, authentication or failed loading never resets history", async () => {
  assert.equal(
    (
      await readState({
        api: async () => {
          throw err(404);
        },
      })
    ).state.posts.length,
    0,
  );
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      readState({
        api: async () => {
          throw err(status);
        },
      }),
      { status },
    );
});
test("409 rereads latest state and preserves another writer; duplicate retry is idempotent", async () => {
  let remote = emptyState(),
    tries = 0;
  const client = {
    BRANCH: "main",
    api: async (path, opt) => {
      if (!opt) return file(remote);
      tries++;
      if (tries === 1) {
        remote.posts.push({ id: "other" });
        throw err(409);
      }
      remote = JSON.parse(Buffer.from(JSON.parse(opt.body).content, "base64"));
      return {};
    },
  };
  await mutateState(client, (s) =>
    appendSnapshot(s, { id: "mine", runId: "one" }),
  );
  assert.equal(remote.posts[0].id, "other");
  assert.equal(remote.snapshots.length, 1);
  assert.equal(tries, 2);
  await mutateState(client, (s) =>
    appendSnapshot(s, { id: "mine", runId: "one" }),
  );
  assert.equal(remote.snapshots.length, 1);
});
test("conflict retry bounded; non-conflict failure does not retry", async () => {
  for (const status of [409, 403]) {
    let writes = 0;
    const client = {
      api: async (path, opt) => {
        if (!opt) return file(emptyState());
        writes++;
        throw err(status);
      },
    };
    await assert.rejects(
      mutateState(client, (s) => s.posts.push({ id: "x" })),
      { status },
    );
    assert.equal(writes, status === 409 ? 3 : 1);
  }
});

test("private persistence rejects the public checkout regardless of working directory", async () => {
  const { privateDirectory } = await import("../tools/private-directory.mjs");
  await assert.rejects(
    privateDirectory(new URL("..", import.meta.url).pathname),
  );
  await assert.rejects(
    privateDirectory(new URL("../tests", import.meta.url).pathname),
  );
  await assert.rejects(privateDirectory(undefined));
});
