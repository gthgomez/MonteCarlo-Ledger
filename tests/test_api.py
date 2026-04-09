import os

# Mock DB PATH for testing
import db_manager
db_manager.DB_PATH = 'test_ledger_api.db'

from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

def test_safe_to_spend_endpoint():
    # Setup mock DB and seed
    if os.path.exists('test_ledger_api.db'):
        os.remove('test_ledger_api.db')
    
    db_manager.init_db()
    
    # Add initial balance using domain rules
    db_manager.add_transaction(amount_cents=50000, category='System', description='Starting Balance', t_type='Adjustment')
    with db_manager.get_db_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarded', 1)")
    
    # Call endpoint without mocked future bills/income
    response = client.get("/safe-to-spend?days_ahead=30")
    assert response.status_code == 200, response.text

    data = response.json()
    assert 'safe_spend_cents' in data

    # With no upcoming events, safe spend should be equal to current balance
    assert data['safe_spend_cents'] == 50000

if __name__ == "__main__":
    test_safe_to_spend_endpoint()
    # Cleanup
    if os.path.exists('test_ledger_api.db'):
        os.remove('test_ledger_api.db')
