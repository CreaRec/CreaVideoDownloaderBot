const ETA_EMA_ALPHA = 0.35;
/** Minimum wall time between first and latest sample before ETA is shown. */
const ETA_MIN_WINDOW_MS = 2_000;
/** Ignore speed samples taken over intervals shorter than this (noisy callbacks). */
const ETA_MIN_SAMPLE_INTERVAL_MS = 250;

export interface DownloadEtaState {
  recordSample: (downloadedBytes: number, totalBytes: number | undefined, nowMs: number) => void;
  reset: () => void;
  getRemainingSeconds: (downloadedBytes: number, totalBytes: number | undefined) => number | undefined;
}

export function createDownloadEtaState(): DownloadEtaState {
  let lastSampleAt: number | undefined;
  let lastDownloadedBytes: number | undefined;
  let firstSampleAt: number | undefined;
  let smoothedBytesPerSecond: number | undefined;

  const reset = (): void => {
    lastSampleAt = undefined;
    lastDownloadedBytes = undefined;
    firstSampleAt = undefined;
    smoothedBytesPerSecond = undefined;
  };

  const recordSample = (downloadedBytes: number, totalBytes: number | undefined, nowMs: number): void => {
    if (totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes <= 0) {
      return;
    }

    if (lastSampleAt === undefined || lastDownloadedBytes === undefined) {
      lastSampleAt = nowMs;
      lastDownloadedBytes = downloadedBytes;
      firstSampleAt = nowMs;
      return;
    }

    const elapsedMs = nowMs - lastSampleAt;
    if (elapsedMs < ETA_MIN_SAMPLE_INTERVAL_MS) {
      return;
    }

    const deltaBytes = downloadedBytes - lastDownloadedBytes;
    if (deltaBytes < 0) {
      reset();
      recordSample(downloadedBytes, totalBytes, nowMs);
      return;
    }

    const instantSpeed = deltaBytes / (elapsedMs / 1000);
    if (!Number.isFinite(instantSpeed) || instantSpeed <= 0) {
      lastSampleAt = nowMs;
      lastDownloadedBytes = downloadedBytes;
      return;
    }

    smoothedBytesPerSecond =
      smoothedBytesPerSecond === undefined
        ? instantSpeed
        : ETA_EMA_ALPHA * instantSpeed + (1 - ETA_EMA_ALPHA) * smoothedBytesPerSecond;

    lastSampleAt = nowMs;
    lastDownloadedBytes = downloadedBytes;
  };

  const getRemainingSeconds = (
    downloadedBytes: number,
    totalBytes: number | undefined,
  ): number | undefined => {
    if (
      totalBytes === undefined ||
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0 ||
      smoothedBytesPerSecond === undefined ||
      smoothedBytesPerSecond <= 0 ||
      firstSampleAt === undefined ||
      lastSampleAt === undefined ||
      lastSampleAt - firstSampleAt < ETA_MIN_WINDOW_MS
    ) {
      return undefined;
    }

    const remainingBytes = totalBytes - downloadedBytes;
    if (remainingBytes <= 0) {
      return 0;
    }

    return remainingBytes / smoothedBytesPerSecond;
  };

  return { recordSample, reset, getRemainingSeconds };
}

export function formatEtaRemainingLabel(remainingSeconds: number | undefined): string {
  if (remainingSeconds === undefined || !Number.isFinite(remainingSeconds)) {
    return "—";
  }

  if (remainingSeconds < 1) {
    return "~1 сек осталось";
  }

  const totalSeconds = Math.max(1, Math.round(remainingSeconds));

  if (totalSeconds < 60) {
    return `~${totalSeconds} сек осталось`;
  }

  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) {
    return `~${minutes} мин осталось`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (remainderMinutes === 0) {
    return `~${hours} ч осталось`;
  }

  return `~${hours} ч ${remainderMinutes} мин осталось`;
}

export function formatProgressPercentWithEta(percent: number, remainingSeconds: number | undefined): string {
  const etaLabel = formatEtaRemainingLabel(remainingSeconds);
  return `${percent}% · ${etaLabel}`;
}
