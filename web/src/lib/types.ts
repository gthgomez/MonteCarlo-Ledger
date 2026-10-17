export interface IncomeItem {
  id?: number | string;
  name: string;
  amount_cents: number;
  frequency: "Weekly" | "Bi-weekly" | "Monthly" | "One-time";
  last_payday: string;
  next_payday: string;
}

export interface PaymentItem {
  id?: number | string;
  name: string;
  amount_cents: number;
  due_day?: number | null;
  recurrence: "Monthly" | "One-time" | "Weekly" | "Bi-weekly";
  due_date?: string | null;
  is_auto_withdraw?: boolean;
}

export interface TransactionItem {
  id?: number | string;
  amount_cents: number;
  category?: string;
  type: "Income" | "Expense" | "Adjustment";
  date: string;
  description?: string;
}

export interface BillOccurrenceItem {
  id?: number | string;
  payment_id: number | string;
  due_date: string;
  paid: boolean;
  transaction_id?: number | string | null;
}

export interface LiabilityItem {
  id: string;
  name: string;
  balance_cents: number;
  apr_basis_points: number;
  min_payment_cents: number;
  kind?: "installment" | "revolving";
  min_payment_percent_bps?: number;
  min_payment_floor_cents?: number;
  due_day_of_month?: number;
}

export interface LedgerState {
  version: "2.0";
  updated_at: string;
  current_balance_cents: number;
  incomes: IncomeItem[];
  payments: PaymentItem[];
  transactions: TransactionItem[];
  bill_occurrences: BillOccurrenceItem[];
  liabilities: LiabilityItem[];
}

export const SAMPLE_LEDGER_STATE: LedgerState = {
  version: "2.0",
  updated_at: new Date().toISOString(),
  current_balance_cents: 345000, // $3,450.00
  incomes: [
    {
      id: "inc-1",
      name: "Primary Bi-weekly Paycheck",
      amount_cents: 220000, // $2,200.00
      frequency: "Bi-weekly",
      last_payday: "2026-10-09",
      next_payday: "2026-10-23",
    },
  ],
  payments: [
    {
      id: "pmt-1",
      name: "Apartment Rent",
      amount_cents: 135000, // $1,350.00
      due_day: 1,
      recurrence: "Monthly",
      is_auto_withdraw: true,
    },
    {
      id: "pmt-2",
      name: "High-Speed Internet",
      amount_cents: 7500, // $75.00
      due_day: 14,
      recurrence: "Monthly",
      is_auto_withdraw: true,
    },
    {
      id: "pmt-3",
      name: "Electric & Utilities",
      amount_cents: 14000, // $140.00
      due_day: 18,
      recurrence: "Monthly",
      is_auto_withdraw: true,
    },
    {
      id: "pmt-4",
      name: "Auto Insurance",
      amount_cents: 11000, // $110.00
      due_day: 25,
      recurrence: "Monthly",
      is_auto_withdraw: true,
    },
  ],
  transactions: [
    {
      id: "tx-1",
      amount_cents: 220000,
      category: "Income",
      type: "Income",
      date: "2026-10-09",
      description: "Paycheck Direct Deposit",
    },
    {
      id: "tx-2",
      amount_cents: -7500,
      category: "Utilities",
      type: "Expense",
      date: "2026-10-14",
      description: "Internet Bill",
    },
    {
      id: "tx-3",
      amount_cents: 132500,
      category: "Adjustment",
      type: "Adjustment",
      date: "2026-10-01",
      description: "Initial Balance Setup",
    },
  ],
  bill_occurrences: [
    {
      id: "occ-1",
      payment_id: "pmt-2",
      due_date: "2026-10-14",
      paid: true,
      transaction_id: "tx-2",
    },
  ],
  liabilities: [
    {
      id: "debt-card",
      name: "Credit Card",
      balance_cents: 240000, // $2,400.00
      apr_basis_points: 2199, // 21.99% APR
      min_payment_cents: 6500,
      kind: "revolving",
      min_payment_percent_bps: 200,
      min_payment_floor_cents: 3500,
    },
    {
      id: "debt-auto",
      name: "Auto Loan",
      balance_cents: 850000, // $8,500.00
      apr_basis_points: 599, // 5.99% APR
      min_payment_cents: 24500,
      kind: "installment",
    },
  ],
};
