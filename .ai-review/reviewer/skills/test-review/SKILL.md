---
name: test-review
description: Review checklist for test code.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.{test,spec}.*", "**/test_*.py", "**/*_test.{py,go}"]
---
- Tests that assert nothing, or only that no exception was thrown.
- Skipped or focused tests committed (`.only`, `.skip`, `xit`, `@pytest.mark.skip` without a reason).
- Real network, clock or random calls without a fake; sleeps used for timing.
- Real-looking personal data in fixtures (it is redacted before review; flag it anyway if a placeholder like [REDACTED_EMAIL] shows it was there).
- One test covering many behaviours; test names that do not say what they check.
