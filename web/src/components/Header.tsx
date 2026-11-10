"use client";

import React from "react";
import { SECTION_LABEL, SECTIONS, type Section } from "@/lib/sections";

interface HeaderProps {
  theme: "light" | "dark" | null;
  onToggleTheme: () => void;
  isSynced: boolean;
  vaultId?: string;
  onOpenSync: () => void;
  onResetDemo: () => void;
  onExportJson: () => void;
  section: Section;
  onNavigate: (section: Section) => void;
}

export function Header({
  theme,
  onToggleTheme,
  isSynced,
  vaultId,
  onOpenSync,
  onResetDemo,
  onExportJson,
  section,
  onNavigate,
}: HeaderProps) {
  const themeLabel = theme === null ? "Theme" : theme === "dark" ? "Use light theme" : "Use dark theme";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold tracking-tight text-ink">MonteCarlo</p>
          <p className="text-sm text-muted">A plan for your money</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenSync}
            aria-label={isSynced && vaultId ? `Cloud Vault ${vaultId}` : "Cloud Vault"}
            className="inline-flex min-h-11 items-center rounded-lg border border-line bg-inset px-3 text-sm font-semibold text-ink"
          >
            Sync
          </button>
          <button
            type="button"
            onClick={onExportJson}
            className="inline-flex min-h-11 items-center rounded-lg border border-line bg-inset px-3 text-sm font-semibold text-ink"
          >
            Export
          </button>
          <button
            type="button"
            onClick={onResetDemo}
            className="inline-flex min-h-11 items-center rounded-lg border border-line bg-inset px-3 text-sm font-semibold text-ink"
          >
            Use sample
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-pressed={theme === "dark"}
            className="inline-flex min-h-11 items-center rounded-lg border border-line bg-inset px-3 text-sm font-semibold text-ink"
          >
            {themeLabel}
          </button>
        </div>
      </div>
      <nav aria-label="Sections" className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-1 px-2 py-1">
          {SECTIONS.map((item) => {
            const selected = item === section;
            return (
              <button
                key={item}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onNavigate(item)}
                className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold ${
                  selected ? "bg-accent text-on-accent" : "text-ink hover:bg-inset"
                }`}
              >
                {SECTION_LABEL[item]}
              </button>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
