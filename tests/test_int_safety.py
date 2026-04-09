from monte_carlo_ledger import db_manager

def test_int_safety():
    # Passing cases
    assert db_manager._to_int_strict(None) == 0
    assert db_manager._to_int_strict(100) == 100
    assert db_manager._to_int_strict(-50) == -50
    assert db_manager._to_int_strict("123") == 123
    assert db_manager._to_int_strict("-456") == -456

    # Failing cases
    failing_inputs = ["100.0", "12.3", "abc", "", " ", "100 ", " 100", "0xFFFF"]
    for inp in failing_inputs:
        try:
            db_manager._to_int_strict(inp)
            raise AssertionError(f"Input '{inp}' should have raised ValueError")
        except ValueError:
            pass

if __name__ == "__main__":
    test_int_safety()
