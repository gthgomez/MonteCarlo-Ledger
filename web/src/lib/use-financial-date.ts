"use client";

import { useEffect, useState } from "react";
import { localDateIso } from "./dates";

/** Keep an already loaded plan on the current local calendar day, even offline. */
export function useFinancialDate(): string {
  const [asOf, setAsOf] = useState(localDateIso);

  useEffect(() => {
    let timer: number;
    function refresh() {
      window.clearTimeout(timer);
      const now = new Date();
      setAsOf(localDateIso(now));
      // A local day can be shorter or longer than 24 hours around a clock change.
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(refresh, Math.max(1, midnight.getTime() - now.getTime()));
    }
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return asOf;
}
