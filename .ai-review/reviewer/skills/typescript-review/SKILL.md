---
name: typescript-review
description: TypeScript and JavaScript review checklist.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"]
---
- Types: `any`, non-null assertions (`!`) and `as` casts that hide real nullability. Exported functions should have explicit return types.
- Async: promises that are neither awaited nor returned; `forEach` with async callbacks; missing try/catch around awaited I/O at boundaries.
- Errors: thrown strings instead of Error objects; caught errors swallowed silently.
- Equality: `==` instead of `===` (except deliberate `== null`).
- React: hooks called conditionally; missing dependency arrays; keys built from array index on reorderable lists.
- Imports: deep relative imports across modules where an alias exists.
