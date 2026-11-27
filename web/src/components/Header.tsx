"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownUp, ArrowRight, CalendarDays, ChartNoAxesCombined, Cloud, Command,
  Download, Eye, EyeOff, FlaskConical, House, Laptop, Leaf, Menu, Moon,
  PanelLeftClose, PanelLeftOpen, PieChart, Plus, Search, Settings2, Sun, X,
} from "lucide-react";
import { SECTION_LABEL, SECTION_QUESTION, SECTIONS, type Section } from "@/lib/sections";
import type { TransactionItem } from "@/lib/types";

const sectionIcon = {
  home: House, money: ArrowDownUp, budget: PieChart, bills: CalendarDays,
  plan: FlaskConical, future: ChartNoAxesCombined, advanced: Settings2,
};
const navGroups = {
  Everyday: ["home", "money", "bills", "budget"],
  Planning: ["future", "plan", "advanced"],
} satisfies Record<string, Section[]>;

interface HeaderProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSystemTheme: () => void;
  privacy: boolean;
  onTogglePrivacy: () => void;
  vaultId?: string;
  onOpenSync: () => void;
  onResetDemo: () => void;
  onExportJson?: () => void;
  onQuickAdd?: () => void;
  transactionSearch?: { entries: TransactionItem[]; open: (query: string) => void };
  section: Section;
  onNavigate: (section: Section) => void;
  usingDemo: boolean;
  isSaving?: boolean;
}

export function Header({
  theme, onToggleTheme, onSystemTheme, privacy, onTogglePrivacy, vaultId, onOpenSync,
  onResetDemo, onExportJson, onQuickAdd, transactionSearch, section, onNavigate, usingDemo, isSaving = false,
}: HeaderProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const themeLabel = theme === "dark" ? "Use light theme" : "Use dark theme";
  function closePalette() {
    dialog.current?.close();
    const target = opener.current;
    if (target?.isConnected && target !== document.body) target.focus();
    else searchButton.current?.focus();
  }

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem("mc-sidebar") === "collapsed");
    } catch {
      // Navigation works with the default layout when preferences cannot be read.
    }
  }, []);

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem("mc-sidebar", next ? "collapsed" : "expanded");
    } catch {
      // The current view can still change without a stored preference.
    }
  }

  function openPalette() {
    const element = dialog.current;
    if (!element || element.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    element.showModal();
    input.current?.focus();
  }

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      // Do not stack a command menu on top of financial or recovery dialogs.
      if (!dialog.current?.open && document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
      event.preventDefault();
      if (!dialog.current?.open) openPalette();
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const needle = query.trim().toLowerCase();
  const hasMatchingActivity = Boolean(transactionSearch && needle.length >= 2 && transactionSearch.entries.some(
    ({ category, description }) => category?.toLowerCase().includes(needle) || description?.toLowerCase().includes(needle),
  ));
  const commands = [
    ...SECTIONS.map((item) => ({
      label: SECTION_LABEL[item], hint: SECTION_QUESTION[item], icon: sectionIcon[item],
      run: () => onNavigate(item), disabled: isSaving,
    })),
    { label: "Record a purchase", hint: "Add a real transaction in Money", icon: Plus, run: onQuickAdd, disabled: !onQuickAdd },
    { label: "Cloud Vault", hint: "Sync and recovery", icon: Cloud, run: onOpenSync, disabled: isSaving || privacy },
    { label: "Export", hint: "Download your ledger JSON", icon: Download, run: onExportJson, disabled: !onExportJson },
    { label: "Use sample", hint: "Replace this workspace after confirmation", icon: Leaf, run: onResetDemo, disabled: isSaving || privacy },
    { label: privacy ? "Reveal finances" : "Hide finances", hint: "Privacy mode", icon: privacy ? Eye : EyeOff, run: onTogglePrivacy, disabled: false },
    { label: themeLabel, hint: "Appearance", icon: theme === "dark" ? Sun : Moon, run: onToggleTheme, disabled: false },
    { label: "Use system theme", hint: "Follow your device appearance", icon: Laptop, run: onSystemTheme, disabled: false },
  ].filter(({ label, hint }) => `${label} ${hint}`.toLowerCase().includes(needle));
  if (hasMatchingActivity && transactionSearch) {
    commands.push({
      label: "Search recorded activity", hint: `Find “${query.trim()}” in Money`, icon: Search,
      run: () => transactionSearch.open(query.trim()), disabled: isSaving,
    });
  }

  function selectCommand(command: (typeof commands)[number]) {
    if (command.disabled || !command.run) return;
    closePalette();
    // Native close restores the opener synchronously; workflow actions can then
    // move focus to their own heading, field, or modal.
    command.run();
  }

  function sectionButton(item: Section) {
    const Icon = sectionIcon[item];
    return (
      <button
        key={item} type="button" className="workspace-nav-item" aria-current={item === section ? "page" : undefined}
        disabled={isSaving} onClick={() => onNavigate(item)} title={SECTION_LABEL[item]}
      >
        <Icon size={17} aria-hidden="true" />
        <span>{SECTION_LABEL[item]}</span>
      </button>
    );
  }

  return (
    <>
      <aside className="workspace-rail" data-collapsed={collapsed} aria-label="Workspace">
        <div className="workspace-rail-heading">
          <div className="workspace-brand">
            <span className="workspace-mark"><Leaf size={19} aria-hidden="true" /></span>
            <span className="workspace-brand-name">MonteCarlo<small>Personal ledger</small></span>
          </div>
          <button type="button" className="workspace-collapse" aria-pressed={collapsed} onClick={toggleSidebar} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
            <span className="sr-only">Compact sidebar</span>
          </button>
        </div>
        <nav aria-label="Workspace sections" className="workspace-rail-nav">
          {Object.entries(navGroups).map(([label, items]) => (
            <div key={label} className="workspace-nav-group">
              <p className="workspace-nav-caption">{label}</p>
              {items.map(sectionButton)}
            </div>
          ))}
        </nav>
        <div className="workspace-rail-footer">
          <span className="workspace-status-dot" aria-hidden="true" />
          <span>{usingDemo ? "Sample workspace" : "Browser ledger"}</span>
        </div>
      </aside>

      <div className="workspace-toolbar" aria-busy={isSaving || undefined}>
        <div className="workspace-location">
          <span className="workspace-mark workspace-mobile-brand"><Leaf size={17} aria-hidden="true" /></span>
          <span className="workspace-mobile-name">MonteCarlo</span>
          <span className="workspace-breadcrumb">Workspace <span aria-hidden="true">/</span> <strong>{SECTION_LABEL[section]}</strong></span>
        </div>
        <div className="workspace-tools">
          <button ref={searchButton} type="button" onClick={openPalette} className="workspace-tool workspace-search" aria-label="Search and commands" aria-keyshortcuts="Control+K Meta+K">
            <Search size={17} aria-hidden="true" /><span>Search</span><kbd><Command size={12} aria-hidden="true" /> K</kbd>
          </button>
          <button type="button" onClick={onTogglePrivacy} className="workspace-tool workspace-icon-tool" aria-label="Privacy mode" aria-pressed={privacy} title="Privacy mode">
            {privacy ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
          <button type="button" onClick={onToggleTheme} className="workspace-tool workspace-icon-tool" aria-label={themeLabel} title={themeLabel}>
            {theme === "dark" ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
          </button>
          <button type="button" onClick={onOpenSync} className="workspace-tool workspace-vault" aria-disabled={isSaving || privacy || undefined}
            aria-label={!privacy && vaultId ? `Cloud Vault ${vaultId}` : "Cloud Vault"} title="Cloud Vault">
            <Cloud size={17} aria-hidden="true" /><span>Cloud Vault</span>
          </button>
        </div>
        <div className="workspace-maintenance">
          {onExportJson && <button type="button" className="workspace-tool" onClick={onExportJson}><Download size={15} aria-hidden="true" /> Export</button>}
          <button type="button" className="workspace-tool" disabled={isSaving || privacy} onClick={onResetDemo}>Use sample</button>
        </div>
        <nav className="workspace-secondary-nav" aria-label="More sections">
          {(["budget", "plan", "advanced"] as const).map(sectionButton)}
        </nav>
      </div>

      <nav className="workspace-mobile-nav" aria-label="Primary sections">
        {(["home", "money"] as const).map(sectionButton)}
        <button type="button" className="workspace-quick-add" aria-label={onQuickAdd ? "Quick add a purchase" : "Open workspace commands"}
          onClick={onQuickAdd ?? openPalette}>
          {onQuickAdd ? <Plus size={23} aria-hidden="true" /> : <Menu size={21} aria-hidden="true" />}
          <span>{onQuickAdd ? "Add" : "Menu"}</span>
        </button>
        {(["bills", "future"] as const).map(sectionButton)}
      </nav>

      <dialog ref={dialog} className="workspace-command" aria-labelledby="workspace-command-title"
        onClick={(event) => { if (event.target === event.currentTarget) closePalette(); }}
        onClose={() => {
          // The browser handles ordinary restoration. A removed opener should
          // never leave focus stranded on the dismissed dialog.
          if ((!opener.current || !opener.current.isConnected) && document.activeElement === document.body) searchButton.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closePalette();
            return;
          }
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          const buttons = [...(results.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          if (buttons.length === 0) return;
          event.preventDefault();
          const index = buttons.findIndex((button) => button === document.activeElement);
          const next = event.key === "ArrowDown"
            ? (index + 1) % buttons.length
            : index <= 0 ? buttons.length - 1 : index - 1;
          buttons[next].focus();
        }}
      >
        <div className="workspace-command-body">
          <div className="workspace-command-title">
            <h2 id="workspace-command-title">Search and commands</h2>
            <button type="button" className="workspace-tool workspace-icon-tool" aria-label="Close commands" onClick={closePalette}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <form onSubmit={(event) => {
            event.preventDefault();
            const first = commands.find((command) => !command.disabled);
            if (first) selectCommand(first);
          }}>
            <label className="sr-only" htmlFor="workspace-query">Find a section, action, or transaction</label>
            <input ref={input} id="workspace-query" className="workspace-command-input" type="search" value={query}
              placeholder="Find a section, action, or transaction…" onChange={(event) => setQuery(event.target.value)} />
          </form>
          <ul className="workspace-command-results" ref={results}>
            {commands.map((command) => (
              <li key={command.label}>
                <button type="button" disabled={command.disabled} onClick={() => selectCommand(command)}>
                  <command.icon size={18} aria-hidden="true" />
                  <span><strong>{command.label}</strong><small>{command.hint}</small></span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {commands.length === 0 && <p className="p-4 text-sm text-muted" role="status">No matching sections or actions.</p>}
        </div>
      </dialog>
    </>
  );
}
