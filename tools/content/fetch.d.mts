/** Types for tools/content/fetch.mjs (the pattern the converter uses with mappers.d.mts). */

export interface ContentSource {
  id: string;
  url: string;
  commit: string;
  ref?: string;
  sparse: string[];
  required: string[];
  license: string;
  usage: string;
}

export interface CheckoutVerdict {
  ok: boolean;
  commit: string | null;
  missing: string[];
  reason: string;
}

export interface FetchRow extends CheckoutVerdict {
  id: string;
  action: "cloned" | "updated" | "up-to-date" | "ok" | "missing";
  files?: number;
  ms?: number;
}

export interface FetchOptions {
  dest?: string;
  only?: Set<string> | null;
  force?: boolean;
  check?: boolean;
  log?: (line: string) => void;
}

export declare const SOURCES_FILE: string;
export declare const DEFAULT_DEST: string;
export declare const CONVERTER_VENDOR: string;
export declare const GIT_ENV: Record<string, string>;

export declare function readSources(file?: string): ContentSource[];
export declare function fetchCommands(
  source: ContentSource,
  dir: string,
  options: { fresh: boolean },
): string[][];
export declare function verifyCheckout(source: ContentSource, dir: string): CheckoutVerdict;
export declare function fetchSources(options?: FetchOptions): FetchRow[];
