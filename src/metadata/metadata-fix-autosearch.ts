import { cleanDownloadTitle } from "./filename-title.js";
import type { TmdbCandidate } from "./tmdb-resolver.js";

export interface MetadataFixSearchQuery {
  query: string;
  year?: number;
  label: string;
}

export function planMetadataFixSearchQueries(fileName: string, extraQuery?: string): MetadataFixSearchQuery[] {
  const fromFile = cleanDownloadTitle(fileName);
  const fromExtra = extraQuery ? cleanDownloadTitle(undefined, extraQuery) : undefined;
  const queries: MetadataFixSearchQuery[] = [];
  const seen = new Set<string>();

  const addQuery = (query: string, year?: number, label?: string) => {
    const trimmed = query.trim();

    if (!trimmed) {
      return;
    }

    const key = `${trimmed.toLowerCase()}|${year ?? ""}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    queries.push({
      query: trimmed,
      year,
      label: label ?? trimmed,
    });
  };

  addQuery(fromFile.query, fromFile.year, fromFile.query);

  if (fromExtra?.query && fromExtra.query !== fromFile.query) {
    addQuery(fromExtra.query, fromExtra.year, fromExtra.query);
  }

  return queries;
}

export function mergeTmdbCandidates(batches: TmdbCandidate[][]): TmdbCandidate[] {
  const seen = new Set<string>();
  const merged: TmdbCandidate[] = [];

  for (const batch of batches) {
    for (const candidate of batch) {
      const key = `${candidate.kind}:${candidate.tmdbId}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(candidate);
    }
  }

  return merged.sort((left, right) => right.score - left.score).slice(0, 5);
}

export function buildAutoSearchLabel(queries: MetadataFixSearchQuery[]): string {
  if (queries.length === 0) {
    return "Автопоиск";
  }

  return `Автопоиск: ${queries.map((entry) => entry.label).join("; ")}`;
}
