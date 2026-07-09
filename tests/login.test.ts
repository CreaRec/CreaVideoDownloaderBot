import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginUserId } from "../src/login.js";

test("parseLoginUserId defaults to the first allowed user", () => {
  assert.equal(parseLoginUserId([], [1234, 5678]), 1234);
});

test("parseLoginUserId reads --user-id from argv", () => {
  assert.equal(parseLoginUserId(["--user-id", "5678"], [1234, 5678]), 5678);
});

test("parseLoginUserId rejects missing --user-id value", () => {
  assert.throws(() => parseLoginUserId(["--user-id"], [1234]), /--user-id/);
});

test("parseLoginUserId rejects non-integer values", () => {
  assert.throws(() => parseLoginUserId(["--user-id", "abc"], [1234]), /Invalid --user-id value/);
});

test("parseLoginUserId rejects users outside allowedUserIds", () => {
  assert.throws(() => parseLoginUserId(["--user-id", "9999"], [1234]), /not listed in telegram\.allowedUserIds/);
});
