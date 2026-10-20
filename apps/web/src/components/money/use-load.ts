// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

export interface Loaded<T> {
  /** null until the first successful load for the current key. */
  data: T | null;
  failed: boolean;
  /** Load again (after an action); the current data stays until the answer arrives. */
  reload: () => void;
}

/**
 * Loads `load()` whenever `key` changes, client-side. An answer for an older key or an older
 * request is dropped, so a slow response cannot overwrite a newer one.
 */
export function useLoad<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = React.useState<{ key: string; data: T | null; failed: boolean }>({
    key,
    data: null,
    failed: false,
  });
  const seq = React.useRef(0);
  const loadRef = React.useRef(load);
  // Declared before the loading effect, so it runs first and the load sees the latest closure.
  React.useEffect(() => {
    loadRef.current = load;
  });

  const run = React.useCallback(() => {
    const id = ++seq.current;
    loadRef
      .current()
      .then((data) => {
        if (id === seq.current) setState({ key, data, failed: false });
      })
      .catch(() => {
        if (id === seq.current) setState((prev) => ({ key, data: prev.key === key ? prev.data : null, failed: true }));
      });
  }, [key]);

  React.useEffect(() => {
    run();
    // The counter object itself, not a DOM ref: bumping it is how in-flight answers get dropped.
    const counter = seq;
    return () => {
      // Unmount or key change: drop whatever is still in flight.
      counter.current++;
    };
  }, [run]);

  const current = state.key === key ? state : { data: null, failed: false };
  return { data: current.data, failed: current.failed, reload: run };
}
