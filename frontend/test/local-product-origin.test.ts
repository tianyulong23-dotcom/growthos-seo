import assert from "node:assert/strict"
import test from "node:test"

import { getCanonicalLocalProductUrl } from "../src/local-product-origin.ts"

test("canonicalizes the local-product frontend loopback address", () => {
  const url = new URL(
    "http://127.0.0.1:5173/projects/aiper-com-bb2f985a/overview?tab=summary#top"
  )

  assert.equal(
    getCanonicalLocalProductUrl(url),
    "http://localhost:5173/projects/aiper-com-bb2f985a/overview?tab=summary#top"
  )
})

test("leaves the canonical and non-local-product origins unchanged", () => {
  assert.equal(
    getCanonicalLocalProductUrl(new URL("http://localhost:5173/")),
    null
  )
  assert.equal(
    getCanonicalLocalProductUrl(new URL("http://127.0.0.1:4173/")),
    null
  )
  assert.equal(
    getCanonicalLocalProductUrl(new URL("https://app.example.com/")),
    null
  )
})
