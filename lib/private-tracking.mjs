import { emptyState } from "./tracking.mjs";
const PATH = "tracking/state.json";
function decode(s) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
  );
}
function encode(s) {
  const bytes = new TextEncoder().encode(s);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}
export async function readState(client) {
  try {
    const file = await client.api(
      `/contents/${PATH}?ref=${client.BRANCH}&t=${Date.now()}`,
    );
    const state = JSON.parse(
      file.content ? decode(file.content) : await client.text(PATH),
    );
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.posts) ||
      !Array.isArray(state.snapshots)
    )
      throw new Error("追跡データの形式が未対応です");
    return { state, sha: file.sha };
  } catch (e) {
    if (e.status === 404) return { state: emptyState(), sha: null };
    throw e;
  }
}
export async function mutateState(client, mutator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, sha } = await readState(client);
    mutator(state);
    state.revision = (state.revision || 0) + 1;
    try {
      await client.api(`/contents/${PATH}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Update private reaction tracking",
          content: encode(JSON.stringify(state, null, 2) + "\n"),
          ...(sha ? { sha } : {}),
          branch: client.BRANCH,
        }),
      });
      return state;
    } catch (e) {
      if (e.status !== 409 || attempt === 2) throw e;
    }
  }
}
