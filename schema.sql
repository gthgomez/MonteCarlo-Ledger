-- Database Schema for Budget Tracker


CREATE TABLE IF NOT EXISTS income (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL, -- Stored in cents
    frequency TEXT CHECK(frequency IN ('Weekly', 'Bi-weekly', 'Monthly', 'One-time')) NOT NULL,
    last_payday DATE NOT NULL,
    next_payday DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL, -- Stored in cents
    due_day INTEGER, -- Day of the month (1-31) for monthly payments
    recurrence TEXT CHECK(recurrence IN ('Monthly', 'One-time', 'Weekly', 'Bi-weekly')) NOT NULL,
    due_date DATE, -- Specific date for one-time, weekly, bi-weekly payments
    is_auto_withdraw BOOLEAN DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL, -- Stored in cents (positive = income/adj, negative = expense/adj)
    category TEXT,
    type TEXT CHECK(type IN ('Income', 'Expense', 'Adjustment')) NOT NULL DEFAULT 'Expense',
    date DATE NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value ANY -- Can be integer or text depending on key
);

CREATE TABLE IF NOT EXISTS bill_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    paid INTEGER DEFAULT 0,
    transaction_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (payment_id) REFERENCES payments(id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_unique ON bill_occurrences(payment_id, due_date);
CREATE INDEX IF NOT EXISTS idx_occurrences_paid ON bill_occurrences(paid);

-- Insert default balance (stored as INTEGER)
INSERT OR IGNORE INTO settings (key, value) VALUES ('current_balance', 0);
