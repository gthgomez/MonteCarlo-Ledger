import os
import sys

# Ensure local modules can be found
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(BASE_DIR)

# Mock DB PATH for testing
import db_manager
db_manager.DB_PATH = 'test_api_budget.db'

from fastapi.testclient import TestClient
from api import app

client = TestClient(app)

def test_safe_to_spend_endpoint():
    # Setup mock DB and seed
    if os.path.exists('test_api_budget.db'):
        os.remove('test_api_budget.db')
    
    db_manager.init_db()
    
    # Add initial balance using domain rules
    db_manager.add_transaction(amount_cents=50000, category='System', description='Starting Balance', t_type='Adjustment')
    with db_manager.get_db_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarded', 1)")
    
    # Call endpoint without mocked future bills/income
    response = client.get("/safe-to-spend?days_ahead=30")
    if response.status_code != 200:
        print(f"❌ /safe-to-spend endpoint failed with status {response.status_code}: {response.text}")
        sys.exit(1)
        
    data = response.json()
    if 'safe_spend_cents' not in data:
        print(f"❌ Response missing 'safe_spend_cents': {data}")
        sys.exit(1)
        
    # With no upcoming events, safe spend should be equal to current balance
    if data['safe_spend_cents'] != 50000:
        print(f"❌ Expected safe spend 50000, got {data['safe_spend_cents']}")
        sys.exit(1)
        
    print("✅ /safe-to-spend endpoint tests passed successfully!")

if __name__ == "__main__":
    test_safe_to_spend_endpoint()
    # Cleanup
    if os.path.exists('test_api_budget.db'):
        os.remove('test_api_budget.db')
