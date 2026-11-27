import type { Metadata } from "next";
import Link from "next/link";
import { Button, Explain, fieldClass, Field, Metric, Notice, Panel } from "@/components/ui";

export const metadata: Metadata = {
  title: "Workspace design reference · MonteCarlo",
  robots: { index: false, follow: false },
};

export default function DesignReference() {
  return (
    <main className="workspace-main space-y-6">
      <Link href="/" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">← Back to workspace</Link>
      <header className="workspace-page-heading">
        <h1>Workspace design reference</h1>
        <p>Shared interface components, using illustrative content only.</p>
      </header>
      <section className="grid gap-3 sm:grid-cols-2" aria-label="Financial display">
        <Metric label="Recorded cash" value="$1,240.50" detail="Example amount as of today." />
        <Metric label="Projected low point" value="—" detail="A forecast is unavailable until the schedule is entered." />
      </section>
      <Panel title="Feedback" lede="Every status has a text label; its meaning never depends on color alone.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Notice title="Empty activity">No entries match the selected filters.</Notice>
          <Notice tone="ok" title="Entry saved">The browser confirmed this change.</Notice>
          <Notice tone="warning" title="Saved ledger changed">Reload before making another change.</Notice>
          <Notice tone="danger" title="Calculation failed">No spending estimate is available.</Notice>
        </div>
      </Panel>
      <Panel title="Fields and disclosure">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" hint="Enter dollars and cents.">
            <input className={fieldClass} inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Example invalid amount" error="Use at most two decimal places.">
            <input className={fieldClass} inputMode="decimal" defaultValue="20.005" aria-invalid="true" />
          </Field>
          <Button type="button" disabled>Saving…</Button>
          <Explain term="recorded cash">The total of posted entries through today.</Explain>
        </div>
      </Panel>
    </main>
  );
}
