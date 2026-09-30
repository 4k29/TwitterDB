import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
export async function privateDirectory(value) {
  if (!value)
    throw new Error(
      "TWITTERDB_DATA_DIR must explicitly identify a private data checkout",
    );
  const directory = await realpath(value);
  const publicRoot = await realpath(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  if (directory === publicRoot || directory.startsWith(publicRoot + sep))
    throw new Error("公開リポジトリ内にデータ・履歴・レポートは保存できません");
  return directory;
}
