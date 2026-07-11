import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginUserId } from "../src/cli/login.js";

test("parseLoginUserId defaults to the only configured user", () => {
  assert.equal(parseLoginUserId([], [1234]), 1234);
});

test("parseLoginUserId reads --user-id from argv", () => {
  assert.equal(parseLoginUserId(["--user-id", "5678"], [1234]), 5678);
});

test("parseLoginUserId rejects missing --user-id value", () => {
  assert.throws(() => parseLoginUserId(["--user-id"], [1234]), /--user-id/);
});

test("parseLoginUserId rejects non-integer values", () => {
  assert.throws(() => parseLoginUserId(["--user-id", "abc"], [1234]), /Invalid --user-id value/);
});

test("parseLoginUserId requires --user-id for the first user", () => {
  assert.throws(() => parseLoginUserId([], []), /Missing --user-id/);
});

test("parseLoginUserId requires --user-id when multiple users are configured", () => {
  assert.throws(() => parseLoginUserId([], [1234, 5678]), /Multiple users are configured/);
});
