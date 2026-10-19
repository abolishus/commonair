// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The operator's network list (`INTEGRITY_DATACENTER_CIDRS_FILE`), loaded once at startup
 * and again on SIGHUP. A list that cannot be read never stops the worker: at startup it
 * scores without one (logged as an error), on reload it keeps the previous list. A reload
 * that parses to no entries while the previous list had some is treated the same way (a
 * truncated or half-written file must not silently switch hosting detection off); operators
 * replace the file atomically (write a temporary file, then rename it over the old one).
 */
import { classifierFromEnv, type NetworkClassifier } from "@commonair/integrity";
import type { Logger } from "@commonair/observability";

/**
 * Ranges plus ASNs in a parsed list. `CidrClassifier` does not expose a size, so this reads
 * its (TypeScript-private) fields; the unit tests pin it against `parseNetworkList`.
 */
export function entryCount(classifier: NetworkClassifier): number {
  const size = (field: string) => {
    const v: unknown = Reflect.get(classifier, field);
    return Array.isArray(v) ? v.length : v instanceof Map ? v.size : 0;
  };
  return size("ranges") + size("asns");
}

export class ClassifierHolder {
  private current: NetworkClassifier | undefined;
  private currentEntries = 0;

  constructor(
    private readonly logger: Logger,
    private readonly source: Record<string, string | undefined> = process.env,
    private readonly load: typeof classifierFromEnv = classifierFromEnv,
  ) {}

  get classifier(): NetworkClassifier | undefined {
    return this.current;
  }

  /** Returns true when the list was (re)loaded. */
  reload(): boolean {
    try {
      const { classifier, invalidLines } = this.load(this.source);
      const entries = entryCount(classifier);
      if (entries === 0 && this.currentEntries > 0) {
        this.logger.warn("network list reload parsed to no entries; keeping the previous list", {
          previous: this.currentEntries,
          invalidLines: invalidLines.length,
        });
        return false;
      }
      this.current = classifier;
      this.currentEntries = entries;
      if (invalidLines.length > 0)
        this.logger.warn("network list has unparseable lines", {
          count: invalidLines.length,
          lines: invalidLines.slice(0, 20),
        });
      this.logger.info("network list loaded", {
        configured: Boolean(this.source.INTEGRITY_DATACENTER_CIDRS_FILE),
        entries,
      });
      return true;
    } catch (err) {
      this.logger.error(
        this.current
          ? "network list reload failed; keeping the previous list"
          : "network list unreadable; scoring without it",
        { err },
      );
      return false;
    }
  }

  /** Reload on SIGHUP; returns a function that removes the handler. */
  watchSighup(): () => void {
    const onHup = () => void this.reload();
    process.on("SIGHUP", onHup);
    return () => process.off("SIGHUP", onHup);
  }
}
