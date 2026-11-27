"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatDateLabel } from "@/lib/dates";
import {
  deleteCashTransaction,
  editCashTransaction,
  parseDollarsToCents,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatDollarsInput, formatMoney } from "@/lib/money-format";
import { type PersistenceResult } from "@/lib/sync-state";
import { type LedgerState, type TransactionItem } from "@/lib/types";
import { Button, fieldClass, Notice, Panel } from "./ui";

type ActivityTypeFilter = "all" | "income" | "expense" | "adjustment";
const PAGE_SIZE = 30;

type ActivitySort =
  | "recorded-desc"
  | "recorded-asc"
  | "date-desc"
  | "date-asc"
  | "amount-desc"
  | "amount-asc"
  | "description-asc";

interface TransactionDraft {
  id: number | string;
  amount: string;
  date: string;
  category: string;
  description: string;
}

const TYPE_FILTER_LABEL: Record<Exclude<ActivityTypeFilter, "all">, string> = {
  income: "money in",
  expense: "money out",
  adjustment: "adjustment",
};

const SORT_OPTIONS: { value: ActivitySort; label: string }[] = [
  { value: "recorded-desc", label: "Newest recorded first" },
  { value: "recorded-asc", label: "Oldest recorded first" },
  { value: "date-desc", label: "Date, newest first" },
  { value: "date-asc", label: "Date, oldest first" },
  { value: "amount-desc", label: "Largest amount first" },
  { value: "amount-asc", label: "Smallest amount first" },
  { value: "description-asc", label: "Description A–Z" },
];

function transactionName(tx: TransactionItem): string {
  return tx.description || tx.category || tx.type;
}

function typeLabel(type: TransactionItem["type"]): string {
  if (type === "Income") return "Money in";
  if (type === "Expense") return "Money out";
  return "Adjustment";
}

function typeChipClass(type: TransactionItem["type"]): string {
  if (type === "Income") return "border-positive bg-positive-soft text-ink";
  if (type === "Adjustment") return "border-warning bg-warning-soft text-ink";
  return "border-line bg-inset text-ink";
}

function amountClass(type: TransactionItem["type"]): string {
  if (type === "Income") return "text-positive";
  if (type === "Adjustment") return "text-muted";
  return "text-ink";
}

function matchesType(type: TransactionItem["type"], filter: ActivityTypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "income") return type === "Income";
  if (filter === "expense") return type === "Expense";
  return type === "Adjustment";
}

export interface MoneyActivityProps {
  state: LedgerState;
  asOf: string;
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
  onDiscardDraft: (draftKey: string) => void;
  saving: boolean;
  initialQuery?: string;
}

/**
 * The recorded cash activity for the one ledger cash pool. Search and type/sort
 * filters only rearrange display rows; they never change totals or ordering in
 * the durable ledger. Corrections use the same domain edit as before, including
 * its failure retry and discard-draft contract.
 */
export function MoneyActivity({ state, asOf, onEdit, onDiscardDraft, saving, initialQuery = "" }: MoneyActivityProps) {
  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>("all");
  const [sort, setSort] = useState<ActivitySort>("date-desc");
  const [page, setPage] = useState(0);
  const resultsHeading = useRef<HTMLParagraphElement>(null);

  const [transactionEdit, setTransactionEdit] = useState<TransactionDraft | null>(null);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [transactionNotice, setTransactionNotice] = useState("");
  const [focusSearchAfterChange, setFocusSearchAfterChange] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusAfterCloseRef = useRef(false);
  const activitySearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (transactionEdit !== null && !dialog.open) {
      dialog.showModal();
    } else if (transactionEdit === null && dialog.open) {
      dialog.close();
    }
  }, [transactionEdit]);

  useEffect(() => {
    if (!focusSearchAfterChange || saving) return;
    setFocusSearchAfterChange(false);
    activitySearchRef.current?.focus();
  }, [focusSearchAfterChange, saving]);

  const indexedTransactions = useMemo(
    () => state.transactions.map((tx, recordedIndex) => ({ tx, recordedIndex })),
    [state.transactions]
  );

  const linkedTransactionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const occurrence of state.bill_occurrences) {
      if (occurrence.transaction_id !== undefined && occurrence.transaction_id !== null) {
        ids.add(String(occurrence.transaction_id));
      }
    }
    return ids;
  }, [state.bill_occurrences]);

  const visibleTransactions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = indexedTransactions.filter(({ tx }) => {
      if (!matchesType(tx.type, typeFilter)) return false;
      if (!needle) return true;
      const description = (tx.description ?? "").toLowerCase();
      const category = (tx.category ?? "").toLowerCase();
      return description.includes(needle) || category.includes(needle);
    });
    const byRecordedOrder = (left: { recordedIndex: number }, right: { recordedIndex: number }) =>
      right.recordedIndex - left.recordedIndex;

    return filtered.sort((left, right) => {
      switch (sort) {
        case "recorded-asc":
          return left.recordedIndex - right.recordedIndex;
        case "date-desc":
          return right.tx.date.localeCompare(left.tx.date) || byRecordedOrder(left, right);
        case "date-asc":
          return left.tx.date.localeCompare(right.tx.date) || left.recordedIndex - right.recordedIndex;
        case "amount-desc":
          return (
            Math.abs(right.tx.amount_cents) - Math.abs(left.tx.amount_cents) ||
            byRecordedOrder(left, right)
          );
        case "amount-asc":
          return (
            Math.abs(left.tx.amount_cents) - Math.abs(right.tx.amount_cents) ||
            byRecordedOrder(left, right)
          );
        case "description-asc":
          return (
            transactionName(left.tx).localeCompare(transactionName(right.tx), "en", {
              sensitivity: "base",
            }) || byRecordedOrder(left, right)
          );
        default:
          return byRecordedOrder(left, right);
      }
    });
  }, [indexedTransactions, query, sort, typeFilter]);

  /**
   * A correction can remove its row from the active search/filter after it is
   * saved. Native dialog focus restoration then has no opener to return to, so
   * fall back to the activity search rather than dropping focus on the body.
   */
  useEffect(() => {
    if (transactionEdit !== null || saving || !restoreFocusAfterCloseRef.current) return;
    restoreFocusAfterCloseRef.current = false;
    const opener = dialogOpenerRef.current;
    if (opener?.isConnected) opener.focus();
    else activitySearchRef.current?.focus();
  }, [transactionEdit, saving, visibleTransactions.length]);

  const total = state.transactions.length;
  const filtersActive = query.trim() !== "" || typeFilter !== "all";
  const hasViewChanges = filtersActive || sort !== "date-desc";
  const pageCount = Math.max(1, Math.ceil(visibleTransactions.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const pageStart = activePage * PAGE_SIZE;
  const pageRows = visibleTransactions.slice(pageStart, pageStart + PAGE_SIZE);
  const scheduledInView = pageRows.filter(({ tx }) => tx.date > asOf).length;
  const editingTransaction =
    transactionEdit === null
      ? null
      : state.transactions.find((tx) => tx.id === transactionEdit.id) ?? null;
  const editingLinked =
    transactionEdit !== null && linkedTransactionIds.has(String(transactionEdit.id));

  function clearFilters() {
    setQuery("");
    setTypeFilter("all");
    setSort("date-desc");
    setPage(0);
  }

  function changePage(next: number) {
    setPage(next);
    resultsHeading.current?.focus();
  }

  function openTransactionEdit(tx: TransactionItem, trigger?: HTMLButtonElement | null) {
    if (tx.id === undefined || tx.type === "Adjustment") return;
    dialogOpenerRef.current = trigger ?? null;
    restoreFocusAfterCloseRef.current = false;
    setTransactionNotice("");
    setTransactionError(null);
    setTransactionEdit({
      id: tx.id,
      amount: formatDollarsInput(Math.abs(tx.amount_cents)),
      date: tx.date,
      category: tx.category ?? "",
      description: tx.description ?? "",
    });
  }

  function closeTransactionEdit() {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    onDiscardDraft("money:edit");
    restoreFocusAfterCloseRef.current = true;
    setTransactionEdit(null);
    setTransactionError(null);
  }

  /** User-initiated close must never discard a write that is still in flight. */
  function requestCloseTransactionEdit() {
    if (saving) return;
    closeTransactionEdit();
  }

  async function submitTransactionEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!transactionEdit || saving) return;
    const amountCents = parseDollarsToCents(transactionEdit.amount);
    if (amountCents === null || amountCents <= 0) {
      setTransactionError("Enter a positive amount with no more than two decimal places.");
      return;
    }
    const original = state.transactions.find((row) => row.id === transactionEdit.id);
    const result = editCashTransaction(state, transactionEdit.id, {
      amountCents,
      date: transactionEdit.date,
      category:
        transactionEdit.category === (original?.category ?? "") ? undefined : transactionEdit.category,
      description:
        transactionEdit.description === (original?.description ?? "")
          ? undefined
          : transactionEdit.description,
    });
    if (!result.ok) {
      setTransactionError(result.error);
      return;
    }
    const saved = await onEdit(result, "money:edit");
    if (!saved.ok) {
      // Keep the submitted draft visible so the person can retry without
      // retyping, including its exact date.
      setTransactionError(saved.error);
      return;
    }
    closeTransactionEdit();
    setTransactionNotice("Transaction updated.");
  }

  async function removeTransaction(tx: TransactionItem) {
    if (tx.id === undefined || saving) return;
    const name = transactionName(tx);
    if (!window.confirm(`Delete “${name}”? If this paid a bill, that bill will be reopened.`)) return;
    setTransactionNotice("");
    const saved = await onEdit(deleteCashTransaction(state, tx.id));
    setTransactionError(saved.ok ? null : saved.error);
    if (saved.ok) {
      setTransactionNotice("Transaction deleted.");
      // The deleted row owned the focused Delete button. Return the person to
      // the activity search instead of leaving focus on a removed element.
      setFocusSearchAfterChange(true);
    }
  }

  function handleDialogCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    requestCloseTransactionEdit();
  }

  const emptyReason = query.trim()
    ? `No description or category matches “${query.trim()}”${
        typeFilter === "all" ? "" : ` in ${TYPE_FILTER_LABEL[typeFilter]} activity`
      }.`
    : typeFilter === "all"
      ? "No recorded entries are available."
      : `No ${TYPE_FILTER_LABEL[typeFilter]} entries are recorded.`;

  return (
    <Panel
      title="Recorded activity"
      lede="Every entry belongs to the single cash pool above. Search or filter the list, then correct a row in place when something is wrong."
    >
      <p className="text-sm text-muted empty:hidden" role="status">{transactionNotice}</p>
      {transactionError && transactionEdit === null && (
        <p className="text-sm text-danger" role="alert">
          {transactionError}
        </p>
      )}

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-inset p-4 text-sm">
          <p className="text-muted">
            No transactions yet. Record income or spending above, or set an opening balance.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-line bg-inset p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_13rem]">
              <label htmlFor="money-activity-search" className="block text-sm font-medium text-ink">
                Search
                <input
                  id="money-activity-search"
                  ref={activitySearchRef}
                  type="search"
                  className={`${fieldClass} mt-1`}
                  value={query}
                  placeholder="Description or category"
                  autoComplete="off"
                  onChange={(event) => { setQuery(event.target.value); setPage(0); }}
                />
              </label>
              <label htmlFor="money-activity-type" className="block text-sm font-medium text-ink">
                Type
                <select
                  id="money-activity-type"
                  className={`${fieldClass} mt-1`}
                  value={typeFilter}
                  onChange={(event) => { setTypeFilter(event.target.value as ActivityTypeFilter); setPage(0); }}
                >
                  <option value="all">All entries</option>
                  <option value="income">Money in</option>
                  <option value="expense">Money out</option>
                  <option value="adjustment">Adjustments</option>
                </select>
              </label>
              <label htmlFor="money-activity-sort" className="block text-sm font-medium text-ink">
                Sort
                <select
                  id="money-activity-sort"
                  className={`${fieldClass} mt-1`}
                  value={sort}
                  onChange={(event) => { setSort(event.target.value as ActivitySort); setPage(0); }}
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p ref={resultsHeading} tabIndex={-1} className="text-sm text-muted" aria-live="polite">
                {pageCount > 1
                  ? `Showing ${pageStart + 1}–${pageStart + pageRows.length} of ${visibleTransactions.length} matching entries`
                  : filtersActive
                  ? `Showing ${visibleTransactions.length} of ${total} recorded ${
                      total === 1 ? "transaction" : "transactions"
                    }`
                  : `${total} recorded ${total === 1 ? "transaction" : "transactions"}`}
                {scheduledInView > 0
                  ? ` · ${scheduledInView} scheduled, not counted in cash yet`
                  : ""}
              </p>
              {hasViewChanges && (
                <Button type="button" variant="quiet" onClick={clearFilters}>
                  Clear search and filters
                </Button>
              )}
            </div>
          </div>

          {visibleTransactions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-line bg-inset p-4 text-sm">
              <p className="font-medium text-ink">No recorded activity matches this view</p>
              <p className="mt-1 text-muted">
                {emptyReason} Try a different search, choose another type, or clear the search and filters.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <div className="hidden border-b border-line pb-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:gap-4">
                <span>Date</span>
                <span>Description</span>
                <span className="text-right">Amount</span>
              </div>
              <ul aria-label="Recorded transactions" className="divide-y divide-line">
                {pageRows.map(({ tx, recordedIndex }) => {
                  const name = transactionName(tx);
                  const editable = tx.id !== undefined && tx.type !== "Adjustment";
                  const linked = tx.id !== undefined && linkedTransactionIds.has(String(tx.id));
                  const scheduled = tx.date > asOf;
                  const category =
                    tx.category && tx.category !== tx.type ? tx.category : null;
                  return (
                    <li
                      key={`${recordedIndex}-${String(tx.id)}`}
                      className="grid gap-2 py-3 text-sm transition-colors hover:bg-inset focus-within:bg-inset sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4"
                    >
                      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start sm:gap-1">
                        <time className="font-medium tabular-nums text-ink" dateTime={tx.date}>
                          {formatDateLabel(tx.date)}
                        </time>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeChipClass(
                            tx.type
                          )}`}
                        >
                          {typeLabel(tx.type)}
                        </span>
                        {scheduled && (
                          <span
                            className="inline-flex items-center rounded-full border border-dashed border-line bg-surface px-2 py-0.5 text-xs font-medium text-muted"
                            title="Dated after today; not part of cash on hand yet."
                          >
                            Scheduled
                          </span>
                        )}
                      </div>

                      <div className="min-w-0">
                        <p className="break-words font-medium text-ink">{name}</p>
                        {(category || linked) && (
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-muted">
                            {category && <span>{category}</span>}
                            {linked && (
                              <span className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium text-muted">
                                Bill payment
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:flex-col sm:items-end sm:gap-2">
                        <p
                          className={`min-w-0 break-words tabular-nums text-base font-semibold ${amountClass(
                            tx.type
                          )}`}
                        >
                          {formatMoney(tx.amount_cents)}
                        </p>
                        {editable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="quiet"
                              aria-label={`Edit ${name}`}
                              aria-haspopup="dialog"
                              aria-controls="transaction-edit-dialog"
                              onClick={(event) => openTransactionEdit(tx, event.currentTarget)}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="quiet"
                              aria-label={`Delete ${name}`}
                              onClick={() => void removeTransaction(tx)}
                            >
                              Delete
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">
                            {tx.type === "Adjustment" ? "System entry" : "Not editable"}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {pageCount > 1 && (
                <nav aria-label="Activity pages" className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Button type="button" variant="quiet" disabled={activePage === 0} onClick={() => changePage(activePage - 1)}>Previous entries</Button>
                  <p className="px-1 text-sm text-muted">Page {activePage + 1} of {pageCount}</p>
                  <Button type="button" variant="quiet" disabled={activePage >= pageCount - 1} onClick={() => changePage(activePage + 1)}>Next entries</Button>
                </nav>
              )}
            </div>
          )}
        </>
      )}

      <dialog
        ref={dialogRef}
        id="transaction-edit-dialog"
        aria-labelledby="transaction-edit-title"
        aria-describedby="transaction-edit-help"
        onCancel={handleDialogCancel}
        className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-ink backdrop:bg-black/50"
      >
        {transactionEdit !== null && (
          <div className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-2xl border border-line bg-surface shadow-xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none sm:border-y-0 sm:border-r-0">
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 id="transaction-edit-title" className="text-lg font-semibold text-ink">
                  Correct this transaction
                </h2>
                <p className="mt-0.5 break-words text-sm text-muted">
                  {editingTransaction
                    ? `${typeLabel(editingTransaction.type)} · ${formatDateLabel(
                        editingTransaction.date
                      )} · ${formatMoney(editingTransaction.amount_cents)}`
                    : "Recorded ledger entry"}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close editor"
                disabled={saving}
                onClick={requestCloseTransactionEdit}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-inset text-ink hover:bg-surface disabled:opacity-50"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={submitTransactionEdit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {editingLinked && (
                  <Notice tone="info" title="Linked to a bill">
                    This transaction settles a bill, so its amount must match that bill. You can still correct its
                    date, category, or note here.
                  </Notice>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-ink">
                    Corrected amount ($)
                    <input
                      className={`${fieldClass} mt-1`}
                      inputMode="decimal"
                      autoComplete="off"
                      autoFocus
                      value={transactionEdit.amount}
                      onChange={(event) =>
                        setTransactionEdit({ ...transactionEdit, amount: event.target.value })
                      }
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink">
                    Corrected date
                    <input
                      className={`${fieldClass} mt-1`}
                      type="date"
                      value={transactionEdit.date}
                      onChange={(event) =>
                        setTransactionEdit({ ...transactionEdit, date: event.target.value })
                      }
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink">
                    Corrected category
                    <input
                      className={`${fieldClass} mt-1`}
                      value={transactionEdit.category}
                      onChange={(event) =>
                        setTransactionEdit({ ...transactionEdit, category: event.target.value })
                      }
                    />
                  </label>
                  <label className="block text-sm font-medium text-ink">
                    Corrected note
                    <input
                      className={`${fieldClass} mt-1`}
                      value={transactionEdit.description}
                      onChange={(event) =>
                        setTransactionEdit({ ...transactionEdit, description: event.target.value })
                      }
                    />
                  </label>
                </div>
                {transactionError && (
                  <p className="text-sm text-danger" role="alert">
                    {transactionError}
                  </p>
                )}
                <p id="transaction-edit-help" className="text-sm text-muted">
                  Saving rechecks the whole ledger. If the save fails, this panel stays open with these values so you
                  can retry. Cancel discards only this correction.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 border-t border-line bg-surface px-4 py-3">
                <Button type="submit" disabled={saving}>Save correction</Button>
                <Button type="button" variant="quiet" disabled={saving} onClick={requestCloseTransactionEdit}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}
      </dialog>
    </Panel>
  );
}
