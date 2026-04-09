import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import budget_engine, domain_rules

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DB_PATH = str(PROJECT_ROOT / "ledger.db")
SCHEMA_PATH = str(BASE_DIR / "schema.sql")

def _to_int_safe(val: Any) -> int:
    """Robustly converts any value to integer, handling strings with decimals. Used for data migrations."""
    if val is None: return 0
    try:
        return int(val)
    except (ValueError, TypeError):
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return 0

def _to_int_strict(val: Any) -> int:
    """Strictly converts to integer. Used for runtime data. Raises on float-strings/non-numerics."""
    if val is None: return 0
    if isinstance(val, int): return val
    if isinstance(val, str):
        # Handle cases like "100" and "-100", but not "100.0"
        if val.isdigit() or (val.startswith('-') and val[1:].isdigit()):
            return int(val)
    raise ValueError(f"Strict integer conversion failed for value: {val}")

@dataclass
class Transaction:
    id: int
    amount: int
    category: str
    type: str
    date: str
    description: str

@dataclass
class IncomeSource:
    id: int
    name: str
    amount: int
    frequency: str
    last_payday: str
    next_payday: str
    expected_amount: Optional[int] = None

@dataclass
class Payment:
    id: int
    name: str
    amount: int
    recurrence: str
    due_day: Optional[int] = None
    due_date: Optional[str] = None
    is_auto_withdraw: bool = True

@dataclass
class BillOccurrence:
    id: int
    payment_id: int
    due_date: str
    paid: bool
    transaction_id: Optional[int] = None
    name: Optional[str] = None # Joint field
    amount: Optional[int] = None # Joint field

@contextmanager
def get_db_connection():
    """Provides a sqlite3 connection with row_factory and automatic closing."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    """Initializes the database and performs versioned migrations."""
    if sqlite3.sqlite_version_info < (3, 25, 0):
        raise RuntimeError(f"SQLite 3.25.0+ is required for Window Functions. Current version: {sqlite3.sqlite_version}")
    
    with open(SCHEMA_PATH, 'r') as f:
        schema = f.read()
    
    with get_db_connection() as conn:
        # Ensure base schema exists before migrations
        with conn:
            conn.executescript(schema)
            
        # Check current user_version
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        
        if version < 2:
            _migrate_v1_to_v2(conn)
        if version < 3:
            _migrate_v2_to_v3(conn)
        if version < 4:
            _migrate_v3_to_v4(conn)
        if version < 5:
            _migrate_v4_to_v5(conn)
        if version < 6:
            _migrate_v5_to_v6(conn)
        if version < 7:
            _migrate_v6_to_v7(conn)
        if version < 8:
            _migrate_v7_to_v8(conn)
        if version < 9:
            _migrate_v8_to_v9(conn)
        if version < 10:
            _migrate_v9_to_v10(conn)
        

def _migrate_v4_to_v5(conn: sqlite3.Connection):
    """
    Sets version to 5. (Schema is already permissive for multiple rows).
    """
    print("[Migration] Upgrading database to Version 5 (Multiple Income Sources)...")
    with conn:
        conn.execute("PRAGMA user_version = 5")
    print("[Migration] Success: Version 5 Upgrade Complete.")

def _migrate_v5_to_v6(conn: sqlite3.Connection):
    """
    Adds 'type' column to 'transactions' table.
    Ensures amount is compatible (INTEGER).
    """
    print("[Migration] Upgrading database to Version 6 (Transaction Types & Column Fixes)...")
    with conn:
        # Check if column already exists (safety)
        cursor = conn.execute("PRAGMA table_info(transactions)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'type' not in columns:
            conn.execute("ALTER TABLE transactions ADD COLUMN type TEXT CHECK(type IN ('Income', 'Expense', 'Adjustment')) NOT NULL DEFAULT 'Expense'")
        
        conn.execute("PRAGMA user_version = 6")
    print("[Migration] Success: Version 6 Upgrade Complete.")

def _migrate_v6_to_v7(conn: sqlite3.Connection):
    """
    Sanitizes values to true integers.
    """
    print("[Migration] Upgrading database to Version 7 (Integer Sanitization)...")
    with conn:
        for table, col in [('income', 'amount'), ('payments', 'amount'), ('transactions', 'amount')]:
            rows = conn.execute(f"SELECT id, {col} FROM {table}").fetchall()
            for r in rows:
                conn.execute(f"UPDATE {table} SET {col} = ? WHERE id = ?", (_to_int_safe(r[col]), r['id']))
                
        rows = conn.execute("SELECT key, value FROM settings WHERE key = 'current_balance'").fetchall()
        for r in rows:
            if r['value']:
                conn.execute("UPDATE settings SET value = ? WHERE key = ?", (_to_int_safe(r['value']), r['key']))
                
        conn.execute("PRAGMA user_version = 7")
    print("[Migration] Success: Version 7 Upgrade Complete.")

def _migrate_v7_to_v8(conn: sqlite3.Connection):
    """
    Version 8: Add expected_amount to income table for projections.
    """
    print("[Migration] Upgrading database to Version 8 (Income Projections)...")
    try:
        conn.execute("ALTER TABLE income ADD COLUMN expected_amount INTEGER")
        conn.execute("PRAGMA user_version = 8")
        print("[Migration] Success: Version 8 Upgrade Complete.")
    except sqlite3.OperationalError:
        # Column might exist if migration was partially applied
        conn.execute("PRAGMA user_version = 8")

def _migrate_v8_to_v9(conn: sqlite3.Connection):
    """
    Version 9: Database-level uniqueness for occurrences.
    Safely deduplicates by prioritizing paid=1 records over unpaid records.
    """
    print("[Migration] Upgrading database to Version 9 (Occurrence Integrity)...")
    with conn:
        conn.execute("""
            DELETE FROM bill_occurrences 
            WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id, 
                           ROW_NUMBER() OVER (
                               PARTITION BY payment_id, due_date 
                               ORDER BY paid DESC, id ASC
                           ) as rn
                    FROM bill_occurrences
                ) WHERE rn = 1
            )
        """)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_unique ON bill_occurrences(payment_id, due_date)")
        
        conn.execute("PRAGMA user_version = 9")
    print("[Migration] Success: Version 9 Upgrade Complete.")

def _migrate_v9_to_v10(conn: sqlite3.Connection):
    """
    Version 10: Enforce relational integrity on bill_occurrences.
    - payment_id now cascades on delete
    - transaction_id is nulled if its transaction disappears
    - orphaned legacy rows are cleaned before copy
    """
    print("[Migration] Upgrading database to Version 10 (Foreign Key Integrity)...")
    with conn:
        conn.execute("DELETE FROM bill_occurrences WHERE payment_id NOT IN (SELECT id FROM payments)")
        conn.execute("""
            UPDATE bill_occurrences
            SET transaction_id = NULL
            WHERE transaction_id IS NOT NULL
              AND transaction_id NOT IN (SELECT id FROM transactions)
        """)

        conn.execute("ALTER TABLE bill_occurrences RENAME TO bill_occurrences_legacy")
        conn.execute("""
            CREATE TABLE bill_occurrences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payment_id INTEGER NOT NULL,
                due_date TEXT NOT NULL,
                paid INTEGER DEFAULT 0,
                transaction_id INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
            )
        """)
        conn.execute("""
            INSERT INTO bill_occurrences (id, payment_id, due_date, paid, transaction_id, created_at)
            SELECT id, payment_id, due_date, paid, transaction_id, created_at
            FROM bill_occurrences_legacy
        """)
        conn.execute("DROP TABLE bill_occurrences_legacy")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_unique ON bill_occurrences(payment_id, due_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_occurrences_paid ON bill_occurrences(paid)")
        conn.execute("PRAGMA user_version = 10")
    print("[Migration] Success: Version 10 Upgrade Complete.")

def _migrate_v3_to_v4(conn: sqlite3.Connection):
    """
    Creates bill_occurrences table and indexes.
    """
    print("[Migration] Upgrading database to Version 4 (Bill Occurrences Support)...")
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bill_occurrences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payment_id INTEGER NOT NULL,
                due_date TEXT NOT NULL,
                paid INTEGER DEFAULT 0,
                transaction_id INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (payment_id) REFERENCES payments(id),
                FOREIGN KEY (transaction_id) REFERENCES transactions(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_occurrences_payment_due ON bill_occurrences(payment_id, due_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_occurrences_paid ON bill_occurrences(paid)")
        conn.execute("PRAGMA user_version = 4")
    print("[Migration] Success: Version 4 Upgrade Complete.")

def _migrate_v1_to_v2(conn: sqlite3.Connection):
    """
    Migrates database from float-based (v1) to integer-cents (v2).
    """
    print("[Migration] Upgrading database to Version 2 (Integer Cents)...")
    with conn:
        # 1. Migrate Settings
        row = conn.execute("SELECT value FROM settings WHERE key = 'current_balance'").fetchone()
        if row and '.' in str(row['value']):
            balance_cents = budget_engine.parse_money_input(str(row['value']))
            conn.execute("UPDATE settings SET value = ? WHERE key = 'current_balance'", (str(balance_cents),))
        
        # 2. Migrate Income
        rows = conn.execute("SELECT id, amount FROM income").fetchall()
        for r in rows:
            if isinstance(r['amount'], float) or (isinstance(r['amount'], str) and '.' in str(r['amount'])):
                conn.execute("UPDATE income SET amount = ? WHERE id = ?", (budget_engine.parse_money_input(str(r['amount'])), r['id']))
                
        # 3. Migrate Payments
        rows = conn.execute("SELECT id, amount FROM payments").fetchall()
        for r in rows:
            if isinstance(r['amount'], float) or (isinstance(r['amount'], str) and '.' in str(r['amount'])):
                conn.execute("UPDATE payments SET amount = ? WHERE id = ?", (budget_engine.parse_money_input(str(r['amount'])), r['id']))
                
        # 4. Migrate Transactions
        rows = conn.execute("SELECT id, amount FROM transactions").fetchall()
        for r in rows:
            if isinstance(r['amount'], float) or (isinstance(r['amount'], str) and '.' in str(r['amount'])):
                conn.execute("UPDATE transactions SET amount = ? WHERE id = ?", (budget_engine.parse_money_input(str(r['amount'])), r['id']))
        
        # Set version to 2
        conn.execute("PRAGMA user_version = 2")
    print("[Migration] Success: Version 2 Upgrade Complete.")

def _migrate_v2_to_v3(conn: sqlite3.Connection):
    """
    Migrates settings.current_balance from TEXT to native INTEGER and sets version to 3.
    """
    print("[Migration] Upgrading database to Version 3 (Native Integer Balance)...")
    with conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'current_balance'").fetchone()
        if row:
            balance_int = int(row['value'])
            conn.execute("UPDATE settings SET value = ? WHERE key = 'current_balance'", (balance_int,))
        
        conn.execute("PRAGMA user_version = 3")
    print("[Migration] Success: Version 3 Upgrade Complete.")

def get_ledger_balance() -> int:
    """Calculates the definitive account balance by summing all transactions."""
    with get_db_connection() as conn:
        res = conn.execute("SELECT SUM(amount) FROM transactions").fetchone()
        return _to_int_strict(res[0])
    return 0  # Unreachable at runtime; satisfies type checker

def get_stored_balance() -> int:
    """Retrieves the cached balance from settings."""
    with get_db_connection() as conn:
        res = conn.execute("SELECT value FROM settings WHERE key = 'current_balance'").fetchone()
        return _to_int_strict(res['value']) if res else 0
    return 0  # Unreachable at runtime; satisfies type checker

def validate_balance_consistency() -> Tuple[bool, int, int]:
    """Checks if ledger sum matches stored balance. Returns (is_consistent, ledger, stored)."""
    with get_db_connection() as conn:
        # Explicitly begin a transaction to guarantee read snapshot isolation
        conn.execute("BEGIN DEFERRED")
        res_ledger = conn.execute("SELECT SUM(amount) FROM transactions").fetchone()
        res_stored = conn.execute("SELECT value FROM settings WHERE key = 'current_balance'").fetchone()
        
        ledger = _to_int_strict(res_ledger[0]) if res_ledger and res_ledger[0] is not None else 0
        stored = _to_int_strict(res_stored['value']) if res_stored else 0
        
        return (ledger == stored, ledger, stored)

def sync_stored_balance():
    """Updates the cached balance to match the ledger sum."""
    ledger = get_ledger_balance()
    with get_db_connection() as conn:
        with conn:
            conn.execute("UPDATE settings SET value = ? WHERE key = 'current_balance'", (ledger,))

def add_income_source(name: str, amount_cents: int, frequency: str, last_payday: str):
    """Adds a new income source."""
    domain_rules.validate_amount_positivity(amount_cents, "Income amount")
    next_payday = budget_engine.get_next_payday(last_payday, frequency)
    with get_db_connection() as conn:
        with conn:
            conn.execute('''
                INSERT INTO income (name, amount, frequency, last_payday, next_payday, expected_amount)
                VALUES (?, ?, ?, ?, ?, NULL)
            ''', (name, amount_cents, frequency, last_payday, next_payday))

def update_income_source(income_id: int, name: str, amount_cents: int, frequency: str, last_payday: str, next_payday: str, expected_amount: Optional[int] = None):
    """Updates an existing income source."""
    domain_rules.validate_amount_positivity(amount_cents, "Income amount")
    if expected_amount is not None:
        domain_rules.validate_amount_positivity(expected_amount, "Expected amount")
    with get_db_connection() as conn:
        with conn:
            conn.execute('''
                UPDATE income 
                SET name = ?, amount = ?, frequency = ?, last_payday = ?, next_payday = ?, expected_amount = ?
                WHERE id = ?
            ''', (name, amount_cents, frequency, last_payday, next_payday, expected_amount, income_id))

def delete_income_source(source_id: int):
    """Removes an income source."""
    with get_db_connection() as conn:
        with conn:
            conn.execute('DELETE FROM income WHERE id = ?', (source_id,))

def update_income_dates(source_id: int, last_payday: str, next_payday: str):
    with get_db_connection() as conn:
        with conn:
            conn.execute('UPDATE income SET last_payday = ?, next_payday = ? WHERE id = ?', (last_payday, next_payday, source_id))

def get_all_income() -> List[IncomeSource]:
    with get_db_connection() as conn:
        rows = conn.execute('SELECT * FROM income ORDER BY id ASC').fetchall()
        return [IncomeSource(
            id=r['id'],
            name=r['name'],
            amount=_to_int_strict(r['amount']),
            frequency=r['frequency'],
            last_payday=r['last_payday'],
            next_payday=r['next_payday'],
            expected_amount=_to_int_strict(r['expected_amount']) if 'expected_amount' in r.keys() and r['expected_amount'] is not None else None
        ) for r in rows]
    return []

def add_payment(name: str, amount_cents: int, recurrence: str, due_info: Any, is_auto: bool = True):
    domain_rules.validate_amount_positivity(amount_cents, "Payment amount")
    with get_db_connection() as conn:
        with conn:
            if recurrence == 'Monthly':
                conn.execute('''
                    INSERT INTO payments (name, amount, recurrence, due_day, is_auto_withdraw)
                    VALUES (?, ?, ?, ?, ?)
                ''', (name, amount_cents, recurrence, due_info, int(is_auto)))
            else:
                conn.execute('''
                    INSERT INTO payments (name, amount, recurrence, due_date, is_auto_withdraw)
                    VALUES (?, ?, ?, ?, ?)
                ''', (name, amount_cents, recurrence, due_info, int(is_auto)))

def update_payment(payment_id: int, name: str, amount_cents: int, recurrence: str, due_info: Any):
    domain_rules.validate_amount_positivity(amount_cents, "Payment amount")
    with get_db_connection() as conn:
        with conn:
            if recurrence == 'Monthly':
                conn.execute('''
                    UPDATE payments 
                    SET name = ?, amount = ?, recurrence = ?, due_day = ?, due_date = NULL 
                    WHERE id = ?
                ''', (name, amount_cents, recurrence, due_info, payment_id))
            else:
                conn.execute('''
                    UPDATE payments 
                    SET name = ?, amount = ?, recurrence = ?, due_date = ?, due_day = NULL 
                    WHERE id = ?
                ''', (name, amount_cents, recurrence, due_info, payment_id))

def delete_payment(payment_id: int):
    with get_db_connection() as conn:
        with conn:
            conn.execute('DELETE FROM payments WHERE id = ?', (payment_id,))

def get_all_payments() -> List[Payment]:
    with get_db_connection() as conn:
        rows = conn.execute('SELECT * FROM payments ORDER BY name ASC').fetchall()
        return [Payment(
            id=r['id'],
            name=r['name'],
            amount=_to_int_strict(r['amount']),
            recurrence=r['recurrence'],
            due_day=r['due_day'],
            due_date=r['due_date'],
            is_auto_withdraw=bool(r['is_auto_withdraw'])
        ) for r in rows]
    return []

def add_transaction(amount_cents: int, category: str, description: str, t_type: str = 'Expense', date_str: Optional[str] = None) -> int:
    """
    Core ledger action. Enforces sign rules and updates balance.
    Income: must be > 0
    Expense: must be < 0
    Adjustment: any sign
    Returns the new transaction's row ID.
    """
    domain_rules.validate_transaction_sign(amount_cents, t_type)
    
    if date_str is None:
        date_str = datetime.now().strftime('%Y-%m-%d')
    
    with get_db_connection() as conn:
        with conn:
            cursor = conn.execute('''
                INSERT INTO transactions (amount, category, type, date, description)
                VALUES (?, ?, ?, ?, ?)
            ''', (amount_cents, category, t_type, date_str, description))
            
            # Update cached balance (direct integer math)
            conn.execute('''
                UPDATE settings 
                SET value = value + ? 
                WHERE key = 'current_balance'
            ''', (amount_cents,))
            
            lastrowid = cursor.lastrowid
            if lastrowid is None:
                raise RuntimeError("Failed to persist transaction row.")
            return int(lastrowid)

def get_transaction_history(limit: int = 20) -> List[Transaction]:
    with get_db_connection() as conn:
        rows = conn.execute('SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?', (limit,)).fetchall()
        return [Transaction(
            id=r['id'],
            amount=_to_int_strict(r['amount']),
            category=r['category'],
            type=r['type'],
            date=r['date'],
            description=r['description']
        ) for r in rows]
    return []

def get_spend_by_category(days: Optional[int] = None) -> List[Dict[str, Any]]:
    """Sums ONLY Expense transactions by category (excludes Adjustments). Returns raw dicts for reporting."""
    query = "SELECT category, SUM(amount) as total FROM transactions WHERE type = 'Expense' "
    params = []
    if days:
        since = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        query += "AND date >= ? "
        params.append(since)
    query += "GROUP BY category ORDER BY total ASC"
    
    with get_db_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]
    return []

def get_adjustment_history(limit: int = 10) -> List[Transaction]:
    """Retrieves recent reconciliation adjustments."""
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM transactions WHERE type = 'Adjustment' ORDER BY date DESC, id DESC LIMIT ?", (limit,)).fetchall()
        return [Transaction(
            id=r['id'],
            amount=_to_int_strict(r['amount']),
            category=r['category'],
            type=r['type'],
            date=r['date'],
            description=r['description']
        ) for r in rows]
    return []

def get_flow_summary(days: Optional[int] = None) -> Dict[str, int]:
    """Calculates total inflows and outflows (Income vs Expense)."""
    since_clause = ""
    params = []
    if days:
        since = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        since_clause = "AND date >= ?"
        params = [since]
    
    with get_db_connection() as conn:
        inflow = conn.execute(f"SELECT SUM(amount) FROM transactions WHERE type = 'Income' {since_clause}", params).fetchone()[0] or 0
        outflow = conn.execute(f"SELECT SUM(amount) FROM transactions WHERE type = 'Expense' {since_clause}", params).fetchone()[0] or 0
        return {'inflow': inflow, 'outflow': abs(outflow)}
    return {'inflow': 0, 'outflow': 0}

def get_unpaid_occurrences(start_date: str, end_date: str) -> List[BillOccurrence]:
    """Retrieves occurrences with paid=0 within a date window (including 30-day lookback for past-due)."""
    # Look back 30 days to catch unpaid past-due bills
    lookback_date = (datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
    with get_db_connection() as conn:
        rows = conn.execute("""
            SELECT o.*, p.name, p.amount 
            FROM bill_occurrences o
            JOIN payments p ON o.payment_id = p.id
            WHERE o.paid = 0 AND o.due_date >= ? AND o.due_date <= ?
            ORDER BY o.due_date ASC
        """, (lookback_date, end_date)).fetchall()
        return [BillOccurrence(
            id=r['id'],
            payment_id=r['payment_id'],
            due_date=r['due_date'],
            paid=bool(r['paid']),
            transaction_id=r['transaction_id'],
            name=r['name'],
            amount=_to_int_strict(r['amount'])
        ) for r in rows]
    return []

def ensure_occurrence_exists(payment_id: int, due_date: str):
    """Checks if an occurrence exists for a payment on a date, creates if not."""
    with get_db_connection() as conn:
        with conn:
            # Check for existing
            res = conn.execute("SELECT id FROM bill_occurrences WHERE payment_id = ? AND due_date = ?", (payment_id, due_date)).fetchone()
            if not res:
                conn.execute("INSERT OR IGNORE INTO bill_occurrences (payment_id, due_date) VALUES (?, ?)", (payment_id, due_date))

def sync_bill_occurrences(start_date: str, end_date: str):
    """
    Synchronizes bill occurrences with the rules defined in the engine (30-day lookback).
    """
    # Look back 30 days to catch missed bills that need generation
    lookback_date = (datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
    payments = [dict(vars(p)) for p in get_all_payments()]
    schedule = budget_engine.get_upcoming_schedule(payments, lookback_date, end_date)
    
    with get_db_connection() as conn:
        with conn:
            for item in schedule:
                pid = item['payment_id']
                date = item['date']
                # Check for existing
                res = conn.execute("SELECT id FROM bill_occurrences WHERE payment_id = ? AND due_date = ?", (pid, date)).fetchone()
                if not res:
                    conn.execute("INSERT OR IGNORE INTO bill_occurrences (payment_id, due_date) VALUES (?, ?)", (pid, date))

def get_obligations_total(start_date: str, end_date: str) -> int:
    """Orchestrates sync and sums up unpaid occurrences."""
    sync_bill_occurrences(start_date, end_date)
    unpaid = get_unpaid_occurrences(start_date, end_date)
    return sum(item.amount or 0 for item in unpaid)

def mark_occurrence_paid(occurrence_id: int, transaction_id: int):
    """Marks an occurrence as paid."""
    with get_db_connection() as conn:
        # Validate occurrence exists
        occ = conn.execute("""
            SELECT o.*, p.amount as expected_amount 
            FROM bill_occurrences o
            JOIN payments p ON o.payment_id = p.id
            WHERE o.id = ?
        """, (occurrence_id,)).fetchone()
        
        # Retrieve transaction for validation
        txn = conn.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
        
        domain_rules.validate_occurrence_link(occ, txn)
        
        # Prevent reuse: Check if this transaction_id is already linked to a DIFFERENT occurrence
        existing = conn.execute("SELECT id FROM bill_occurrences WHERE transaction_id = ? AND id != ?", (transaction_id, occurrence_id)).fetchone()
        if existing:
            raise ValueError(f"Transaction {transaction_id} is already linked to another bill occurrence.")
            
        with conn:
            conn.execute("UPDATE bill_occurrences SET paid = 1, transaction_id = ? WHERE id = ?", (transaction_id, occurrence_id))

def get_next_unpaid_occurrence(payment_id: int) -> Optional[BillOccurrence]:
    """Finds the next unpaid occurrence for a payment."""
    with get_db_connection() as conn:
        row = conn.execute("""
            SELECT o.*, p.name, p.amount 
            FROM bill_occurrences o
            JOIN payments p ON o.payment_id = p.id
            WHERE o.payment_id = ? AND o.paid = 0 
            ORDER BY o.due_date ASC LIMIT 1
        """, (payment_id,)).fetchone()
        if not row: return None
        return BillOccurrence(
            id=row['id'],
            payment_id=row['payment_id'],
            due_date=row['due_date'],
            paid=bool(row['paid']),
            transaction_id=row['transaction_id'],
            name=row['name'],
            amount=_to_int_strict(row['amount'])
        )
    return None

def is_onboarded() -> bool:
    """Checks if the user has completed the onboarding wizard."""
    with get_db_connection() as conn:
        res = conn.execute("SELECT value FROM settings WHERE key = 'onboarded'").fetchone()
        if res:
            return bool(_to_int_strict(res['value']))
    return False

def set_onboarded(status: bool = True):
    """Marks the user as onboarded."""
    val = 1 if status else 0
    with get_db_connection() as conn:
        with conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarded', ?)", (val,))
