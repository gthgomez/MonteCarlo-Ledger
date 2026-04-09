import importlib
import sys

_module = importlib.import_module("monte_carlo_ledger.db_manager")
sys.modules[__name__] = _module
