import {
  createPublicFetch,
  dedupeProvenance,
  type Listing,
  type ListingProvenance,
  type LookupFn,
  type X402Resource,
} from "@vapi-network/core";

export type Fetch = typeof fetch;
export type GuardedSourceOptions = Readonly<{
  fetch?: Fetch;
  allowPrivateNetwork?: boolean;
  lookup?: LookupFn;
}>;

export function sourceFetch(options: GuardedSourceOptions): Fetch {
  return (
    options.fetch ??
    createPublicFetch({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    })
  );
}

export function appendPath(baseUrl: string, suffix: string): URL {
  const base = new URL(baseUrl);
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  if (base.pathname.replace(/\/+$/, "").endsWith(`/${normalizedSuffix}`)) {
    return base;
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${normalizedSuffix}`;
  return base;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.flatMap((item) => {
    const string = asString(item);
    return string === undefined ? [] : [string];
  });
  return strings.length > 0 ? strings : undefined;
}

export function asHttpResource(value: unknown): X402Resource | undefined {
  const directUrl = asString(value);
  if (directUrl !== undefined && isHttpUrl(directUrl)) return { url: directUrl };

  const record = asRecord(value);
  const url = asString(record?.url);
  if (url === undefined || !isHttpUrl(url)) return undefined;
  const description = asString(record?.description);
  const mimeType = asString(record?.mimeType);
  return {
    url,
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

export function queryMatches(query: string | undefined, ...values: unknown[]): boolean {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return true;
  return values.some((value) => searchableText(value).includes(needle));
}

export function normalizeListing(
  value: unknown,
  provenance: ListingProvenance,
): Listing | undefined {
  const candidate = asRecord(value);
  const resource = asHttpResource(candidate?.resource);
  if (candidate === undefined || resource === undefined) return undefined;

  const suppliedProvenance = Array.isArray(candidate.provenance)
    ? candidate.provenance.flatMap((item) => {
        const record = asRecord(item);
        const source = asString(record?.source);
        if (source === undefined) return [];
        const sourceUrl = asString(record?.sourceUrl);
        const ref = asString(record?.ref);
        return [
          {
            source,
            ...(sourceUrl === undefined ? {} : { sourceUrl }),
            ...(ref === undefined ? {} : { ref }),
          },
        ];
      })
    : [];
  const accepts = Array.isArray(candidate.accepts) ? candidate.accepts : undefined;
  const metadata = asRecord(candidate.metadata);

  return {
    resource,
    ...optionalString(candidate, "name"),
    ...optionalString(candidate, "description"),
    ...optionalString(candidate, "method"),
    ...optionalString(candidate, "network"),
    ...optionalString(candidate, "price"),
    ...(accepts === undefined ? {} : { accepts }),
    ...(metadata === undefined ? {} : { metadata }),
    provenance: dedupeProvenance([...suppliedProvenance, provenance]),
  };
}

function optionalString(
  record: Record<string, unknown>,
  key: "name" | "description" | "method" | "network" | "price",
): Partial<Record<typeof key, string>> {
  const value = asString(record[key]);
  return value === undefined ? {} : { [key]: value };
}

function searchableText(value: unknown): string {
  if (typeof value === "string") return value.toLocaleLowerCase();
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value).toLocaleLowerCase();
  } catch {
    return "";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
