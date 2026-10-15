---
name: python-review
description: Python review checklist.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/*.py"]
---
- Mutable default arguments (`def f(x=[])`).
- Bare `except:` or `except Exception: pass` that hides failures.
- Missing type hints on public functions when the codebase uses them.
- `print` used for logging in library or service code.
- Resources opened without a context manager (`open`, DB connections, locks).
- String-formatted SQL (`f"SELECT ... {x}"`) instead of parameters.
- Blocking calls (requests, time.sleep) inside async functions.
