import assert from "node:assert/strict";
import test from "node:test";

import { workerCapabilities } from "../src/worker.js";

test("browser worker capabilities are unique", () => {
  assert.equal(new Set(workerCapabilities).size, workerCapabilities.length);
});
