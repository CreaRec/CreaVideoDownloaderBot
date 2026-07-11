import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveDownloads } from "../src/download/active-downloads.js";

test("register and abort abort the matching controller", () => {
  const active = new ActiveDownloads();
  const controller = new AbortController();

  active.register("tok-1", controller);
  assert.equal(controller.signal.aborted, false);

  active.abort("tok-1");
  assert.equal(controller.signal.aborted, true);
});

test("clear without a controller removes the token", () => {
  const active = new ActiveDownloads();
  const controller = new AbortController();

  active.register("tok-1", controller);
  active.clear("tok-1");
  active.abort("tok-1");
  assert.equal(controller.signal.aborted, false);
});

test("clear with a mismatched controller leaves the registered controller", () => {
  const active = new ActiveDownloads();
  const first = new AbortController();
  const second = new AbortController();

  active.register("tok-1", first);
  active.clear("tok-1", second);
  active.abort("tok-1");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test("clear with the matching controller removes the token", () => {
  const active = new ActiveDownloads();
  const controller = new AbortController();

  active.register("tok-1", controller);
  active.clear("tok-1", controller);
  active.abort("tok-1");
  assert.equal(controller.signal.aborted, false);
});
