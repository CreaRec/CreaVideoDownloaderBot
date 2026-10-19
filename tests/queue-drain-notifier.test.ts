import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createQueueDrainCompleteMessage,
  QueueDrainNotifier,
} from "../src/download/queue-drain-notifier.js";

test("QueueDrainNotifier emits one summary when the queue drains", () => {
  const notifier = new QueueDrainNotifier();

  notifier.begin();
  notifier.begin();
  assert.equal(notifier.complete("success", "a.mkv"), undefined);
  const summary = notifier.complete("failed", "b.mkv");

  assert.deepEqual(summary, {
    succeeded: 1,
    failed: 1,
    skipped: 0,
    failedItems: ["b.mkv"],
  });
});

test("createQueueDrainCompleteMessage lists failed items", () => {
  const message = createQueueDrainCompleteMessage({
    succeeded: 2,
    failed: 1,
    skipped: 0,
    failedItems: ["broken.mkv"],
  });

  assert.match(message, /Succeeded: 2/);
  assert.match(message, /Failed: 1/);
  assert.match(message, /broken\.mkv/);
});
