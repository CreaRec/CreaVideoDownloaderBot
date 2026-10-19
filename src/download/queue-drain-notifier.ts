import type { ReplyFn } from "../telegram/telegram-ctx.js";

export type QueueItemOutcome = "success" | "failed" | "skipped";

export interface QueueDrainSummary {
  succeeded: number;
  failed: number;
  skipped: number;
  failedItems: string[];
}

export function createQueueDrainCompleteMessage(summary: QueueDrainSummary): string {
  const lines = [
    "All queued downloads are finished.",
    `Succeeded: ${summary.succeeded}`,
    `Failed: ${summary.failed}`,
    `Skipped: ${summary.skipped}`,
  ];

  if (summary.failedItems.length > 0) {
    lines.push("", "Failed items:");
    for (const item of summary.failedItems) {
      lines.push(`• ${item}`);
    }
  }

  return lines.join("\n");
}

export class QueueDrainNotifier {
  private inFlight = 0;
  private processed = 0;
  private succeeded = 0;
  private failed = 0;
  private skipped = 0;
  private readonly failedItems: string[] = [];

  begin(): void {
    this.inFlight += 1;
  }

  complete(outcome: QueueItemOutcome, fileName: string): QueueDrainSummary | undefined {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.processed += 1;

    if (outcome === "success") {
      this.succeeded += 1;
    } else if (outcome === "failed") {
      this.failed += 1;
      this.failedItems.push(fileName);
    } else {
      this.skipped += 1;
    }

    if (this.inFlight > 0 || this.processed === 0) {
      return undefined;
    }

    const summary: QueueDrainSummary = {
      succeeded: this.succeeded,
      failed: this.failed,
      skipped: this.skipped,
      failedItems: [...this.failedItems],
    };

    this.resetCounters();
    return summary;
  }

  async notifyIfDrained(reply: ReplyFn, summary: QueueDrainSummary | undefined): Promise<void> {
    if (!summary) {
      return;
    }

    await reply(createQueueDrainCompleteMessage(summary));
  }

  private resetCounters(): void {
    this.processed = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.skipped = 0;
    this.failedItems.length = 0;
  }
}
