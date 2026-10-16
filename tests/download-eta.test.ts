import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDownloadEtaState,
  formatEtaRemainingLabel,
  formatProgressPercentWithEta,
} from "../src/download/download-eta.js";

test("formatEtaRemainingLabel uses an em dash when ETA is unknown", () => {
  assert.equal(formatEtaRemainingLabel(undefined), "—");
  assert.equal(formatProgressPercentWithEta(12, undefined), "12% · —");
});

test("formatEtaRemainingLabel rounds human-readable durations", () => {
  assert.equal(formatEtaRemainingLabel(45), "~45 сек осталось");
  assert.equal(formatEtaRemainingLabel(180), "~3 мин осталось");
  assert.equal(formatEtaRemainingLabel(3_700), "~1 ч осталось");
  assert.equal(formatEtaRemainingLabel(4_500), "~1 ч 15 мин осталось");
});

test("download ETA state smooths speed and requires a short warm-up window", () => {
  const eta = createDownloadEtaState();
  const totalBytes = 10_000;
  let now = 0;

  eta.recordSample(0, totalBytes, now);
  assert.equal(eta.getRemainingSeconds(0, totalBytes), undefined);

  now += 1_000;
  eta.recordSample(2_000, totalBytes, now);
  assert.equal(eta.getRemainingSeconds(2_000, totalBytes), undefined);

  now += 1_500;
  eta.recordSample(5_000, totalBytes, now);
  const remaining = eta.getRemainingSeconds(5_000, totalBytes);
  assert.ok(remaining !== undefined);
  assert.ok(remaining > 0);
  assert.ok(remaining < 20);
});

test("download ETA state ignores noisy sub-interval samples", () => {
  const eta = createDownloadEtaState();
  const totalBytes = 1_000_000;
  let now = 0;

  eta.recordSample(0, totalBytes, now);
  now += 100;
  eta.recordSample(50_000, totalBytes, now);
  now += 3_000;
  eta.recordSample(100_000, totalBytes, now);

  const remaining = eta.getRemainingSeconds(100_000, totalBytes);
  assert.ok(remaining !== undefined);
  assert.ok(remaining > 20);
});
