import sys
import os

# Ensure local modules can be found
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(BASE_DIR, '..')) # Adjust if necessary, but /tmp is usually separate

# We need to import from the project dir
PROJECT_DIR = r'c:\Users\icbag\Desktop\Antigavity_Projects\Montecarlo_Budget_Sim'
sys.path.append(PROJECT_DIR)

import db_manager

def test_int_safety():
    print("Running _to_int_strict tests...")
    
    # Passing cases
    assert db_manager._to_int_strict(None) == 0
    assert db_manager._to_int_strict(100) == 100
    assert db_manager._to_int_strict(-50) == -50
    assert db_manager._to_int_strict("123") == 123
    assert db_manager._to_int_strict("-456") == -456
    print("✅ Basic passing cases OK")
    
    # Failing cases
    failing_inputs = ["100.0", "12.3", "abc", "", " ", "100 ", " 100", "0xFFFF"]
    for inp in failing_inputs:
        try:
            db_manager._to_int_strict(inp)
            print(f"❌ FAILED: Input '{inp}' should have raised ValueError")
            sys.exit(1)
        except ValueError:
            pass
    print("✅ Strict failing cases OK")
    
    print("All _to_int_strict tests passed! 🎉")

if __name__ == "__main__":
    test_int_safety()
