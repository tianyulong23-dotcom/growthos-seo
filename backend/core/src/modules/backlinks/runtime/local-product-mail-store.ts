import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  resolve,
  sep,
} from "node:path";

import {
  createSanitizedReplyMailContentReader,
} from "../adapters/gmail/sanitizer-mail-content-reader.js";

const sha256 = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

export class LocalProductMailRawObjectStore {
  readonly #rootDirectory: string;
  readonly #rootPrefix: string;

  constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#rootPrefix = `${this.#rootDirectory}${sep}`;
  }

  #pathFor(objectKey: string): string {
    const segments = objectKey.split("/");
    if (
      objectKey.trim().length === 0
      || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_OBJECT_KEY_INVALID");
    }
    const target = resolve(this.#rootDirectory, ...segments);
    if (!target.startsWith(this.#rootPrefix)) {
      throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_OBJECT_KEY_INVALID");
    }
    return target;
  }

  async putIfAbsent(input: Readonly<{
    objectKey: string;
    content: Uint8Array;
    contentSha256: string;
  }>): Promise<void> {
    if (sha256(input.content) !== input.contentSha256) {
      throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_CONTENT_HASH_INVALID");
    }
    const target = this.#pathFor(input.objectKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, input.content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (sha256(existing) !== input.contentSha256) {
        throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_OBJECT_CONFLICT");
      }
    }
  }

  async get(input: Readonly<{
    rawObjectKey: string;
  }>): Promise<Uint8Array | null> {
    try {
      return await readFile(this.#pathFor(input.rawObjectKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

export function createLocalProductReplyMailContentReader(
  rootDirectory: string,
) {
  const store = new LocalProductMailRawObjectStore(rootDirectory);
  return createSanitizedReplyMailContentReader({
    rawObjectReader: {
      get: (input) => store.get(input),
    },
  });
}
