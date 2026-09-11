import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/ and dist/ occupy the same level; neither cwd nor the original author's home is used.
const coreDirectory = fileURLToPath(new URL("../../../../", import.meta.url));

export function resolveResourceLibraryPath(
  environment: NodeJS.ProcessEnv,
  root = coreDirectory,
): string | undefined {
  if (environment.RESOURCE_LIBRARY_ENABLED?.trim().toLowerCase() === "false") return undefined;
  return resolve(root, environment.RESOURCE_LIBRARY_SQLITE_PATH?.trim()
    || "resources/resource-library/bundled/publishers.sqlite");
}
