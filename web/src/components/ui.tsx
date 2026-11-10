import React from "react";

export const fieldClass =
  "w-full min-h-11 rounded-lg border border-line bg-surface px-3 text-base text-ink";

type Tone = "info" | "warning" | "danger" | "ok";

const toneClass: Record<Tone, string> = {
  info: "border-line bg-inset text-ink",
  warning: "border-warning bg-warning-soft text-ink",
  danger: "border-danger bg-danger-soft text-ink",
  ok: "border-positive bg-positive-soft text-ink",
};

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-1" : undefined}>{children}</div>
    </div>
  );
}

export function Panel({
  title,
  lede,
  children,
  id,
}: {
  title: string;
  lede?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {lede && <p className="mt-1 max-w-3xl text-sm text-muted">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <h3 className="text-sm font-medium text-muted">{label}</h3>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink sm:text-3xl">{value}</p>
      <p className="mt-2 text-sm text-muted">{detail}</p>
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" | "danger" }) {
  const styles = {
    primary: "bg-accent text-on-accent hover:opacity-90",
    quiet: "border border-line bg-inset text-ink hover:bg-surface",
    danger: "border border-danger bg-danger-soft text-ink hover:opacity-90",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold ${styles} disabled:opacity-50 ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-muted">{hint}</span>}
      <div className="mt-1">{children}</div>
      {error && (
        <span className="mt-1 block text-danger" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Explain({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-line bg-inset px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-ink">What “{term}” means</summary>
      <div className="mt-2 text-muted">{children}</div>
    </details>
  );
}
