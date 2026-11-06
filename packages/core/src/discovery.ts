import type { X402Resource } from "./x402.js";
import type { ListingVerification } from "./marketplace-contracts.js";
import { appendSearchEvent } from "./searches.js";

export type ListingProvenance = Readonly<{
  /** Stable adapter identifier such as `vapi`, `bazaar`, or `local`. */
  source: string;
  /** Catalog endpoint used to obtain the listing, when applicable. */
  sourceUrl?: string;
  /** Source-native reference that can be passed back to inspect(). */
  ref?: string;
}>;

export interface Listing {
  readonly resource: X402Resource;
  readonly name?: string;
  readonly description?: string;
  readonly method?: string;
  readonly network?: string;
  readonly price?: string;
  /** Raw x402 accepts entries; source adapters intentionally tolerate new schemes. */
  readonly accepts?: readonly unknown[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * How far the listing got through vAPI review, when its catalog says. A
   * catalog that has no notion of vAPI verification leaves it undefined rather
   * than claiming `none`.
   */
  readonly verification?: ListingVerification;
  readonly provenance: readonly ListingProvenance[];
}

/**
 * What a caller may ask of every source at search time. A source that has no
 * notion of an option ignores it rather than failing.
 */
export type SourceSearchOptions = Readonly<{
  /**
   * Include self-listed APIs vAPI has not verified. Default results are
   * vAPI-verified listings plus mirrored external catalogs.
   */
  includeUnverified?: boolean;
  /** Include API listings whose recent health checks show an outage. */
  includeOutage?: boolean;
}>;

/** Discovery adapter seam. A null inspect result means the reference is unknown. */
export interface Source {
  readonly id: string;
  search(query?: string, options?: SourceSearchOptions): Promise<Listing[]>;
  inspect(ref: string): Promise<Listing | null>;
}

/**
 * Merge source result sets in preference order. Listings with the same resource
 * URL become one result; earlier sources win fields and all provenance is kept.
 */
export function mergeListings(groups: Iterable<readonly Listing[]>): Listing[] {
  const merged = new Map<string, Listing>();
  for (const group of groups) {
    for (const listing of group) {
      const key = normalizeResourceUrl(listing.resource.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, cloneListing(listing));
        continue;
      }
      merged.set(key, mergeListing(existing, listing));
    }
  }
  return [...merged.values()];
}

/** Canonical key used for discovery de-duplication without changing the published URL. */
export function normalizeResourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.trim();
  }
}

/** Search all sources without letting one unavailable catalog hide the others. */
export async function discover(
  sources: readonly Source[],
  query?: string,
  options: {
    searchesPath?: string;
    now?: Date;
    nowMs?: () => number;
  } & SourceSearchOptions = {},
): Promise<{ listings: Listing[]; errors: ReadonlyArray<{ source: string; error: unknown }> }> {
  const nowMs = options.nowMs ?? (() => performance.now());
  const startedAt = options.now ?? new Date();
  const searchOptions: SourceSearchOptions = {
    ...(options.includeUnverified === undefined
      ? {}
      : { includeUnverified: options.includeUnverified }),
    ...(options.includeOutage === undefined ? {} : { includeOutage: options.includeOutage }),
  };
  const settled = await Promise.all(
    sources.map(async (source) => {
      const started = nowMs();
      try {
        const listings = await source.search(query, searchOptions);
        return {
          status: "fulfilled" as const,
          source: source.id,
          listings,
          latencyMs: Math.max(0, nowMs() - started),
        };
      } catch (error) {
        return {
          status: "rejected" as const,
          source: source.id,
          error,
          latencyMs: Math.max(0, nowMs() - started),
        };
      }
    }),
  );
  const groups: Listing[][] = [];
  const errors: Array<{ source: string; error: unknown }> = [];
  for (const result of settled) {
    if (result.status === "fulfilled") groups.push(result.listings);
    else errors.push({ source: result.source, error: result.error });
  }
  const listings = mergeListings(groups);
  if (options.searchesPath) {
    await appendSearchEvent(
      {
        timestamp: startedAt.toISOString(),
        query: query ?? "",
        sources: settled.map((result) => ({
          source: result.source,
          latencyMs: result.latencyMs,
          count: result.status === "fulfilled" ? result.listings.length : 0,
          ...(result.status === "rejected"
            ? { error: result.error instanceof Error ? result.error.message : String(result.error) }
            : {}),
        })),
        mergedCount: listings.length,
      },
      options.searchesPath,
    ).catch(() => undefined);
  }
  return { listings, errors };
}

function cloneListing(listing: Listing): Listing {
  return {
    ...listing,
    resource: {
      ...listing.resource,
      ...(listing.resource.tags ? { tags: [...listing.resource.tags] } : {}),
    },
    ...(listing.accepts ? { accepts: [...listing.accepts] } : {}),
    ...(listing.metadata ? { metadata: { ...listing.metadata } } : {}),
    provenance: dedupeProvenance(listing.provenance),
  };
}

function mergeListing(first: Listing, next: Listing): Listing {
  const accepts =
    first.accepts && first.accepts.length > 0
      ? first.accepts
      : next.accepts && next.accepts.length > 0
        ? next.accepts
        : undefined;
  return {
    resource: {
      url: first.resource.url,
      ...optionalResource("description", first.resource.description, next.resource.description),
      ...optionalResource("mimeType", first.resource.mimeType, next.resource.mimeType),
      ...optionalResource("serviceName", first.resource.serviceName, next.resource.serviceName),
      ...optionalResource("iconUrl", first.resource.iconUrl, next.resource.iconUrl),
      ...(first.resource.tags?.length || next.resource.tags?.length
        ? {
            tags: [
              ...(first.resource.tags?.length ? first.resource.tags : (next.resource.tags ?? [])),
            ],
          }
        : {}),
    },
    ...optional("name", preferred(first.name, next.name)),
    ...optional("description", preferred(first.description, next.description)),
    ...optional("method", preferred(first.method, next.method)),
    ...optional("network", preferred(first.network, next.network)),
    ...optional("price", preferred(first.price, next.price)),
    ...(accepts ? { accepts: [...accepts] } : {}),
    ...((first.verification ?? next.verification) === undefined
      ? {}
      : { verification: (first.verification ?? next.verification)! }),
    ...(first.metadata || next.metadata
      ? { metadata: { ...(next.metadata ?? {}), ...(first.metadata ?? {}) } }
      : {}),
    provenance: dedupeProvenance([...first.provenance, ...next.provenance]),
  };
}

function preferred(first: string | undefined, next: string | undefined): string | undefined {
  return first && first.length > 0 ? first : next;
}

function optionalResource<Key extends "description" | "mimeType" | "serviceName" | "iconUrl">(
  key: Key,
  first: string | undefined,
  next: string | undefined,
): Partial<Record<Key, string>> {
  return optional(key, preferred(first, next));
}

function optional<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value === undefined || value === "" ? {} : ({ [key]: value } as Record<Key, string>);
}

/** Keep the first provenance entry for each source, catalog URL, and native reference. */
export function dedupeProvenance(values: readonly ListingProvenance[]): ListingProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.source}\u0000${value.sourceUrl ?? ""}\u0000${value.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
