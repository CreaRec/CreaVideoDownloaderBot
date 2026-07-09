export function formatMigrationProgress(current: number, total: number, message: string): string {
  const width = String(total).length;
  const index = String(current).padStart(width, " ");
  return `[${index}/${total}] ${message}`;
}
