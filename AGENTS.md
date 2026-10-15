<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:ai-review-rules -->
# Code review rules

The AI reviewer checks every pull request against these rules and cites them by id.

## General

- [GEN-001] No TODO or FIXME comments without a ticket reference, for example TODO(SHOP-123).
- [GEN-002] No console.log in server code, and never log personal data, tokens, cookies or full request bodies.

## Security

- [SEC-001] Never build SQL or queries with string concatenation or template literals from input; use parameterised queries.
- [SEC-002] Validate all input from requests, FormData, params and searchParams before using it.
- [SEC-003] Secrets stay in server-only modules and non-NEXT_PUBLIC env vars.

## Next.js (applies to: src/app/**, src/components/**, src/proxy.ts)

- [NEXT-001] Every Server Action ("use server") must authenticate and authorise inside the action, using getSession() or requireAdmin() from src/lib/auth.ts.
- [NEXT-002] Route handlers must call requireAdmin() before any write and validate the request body.
- [NEXT-003] cookies(), headers(), params and searchParams are async in Next.js 16 and must be awaited.
- [NEXT-004] Data access goes through src/lib modules marked import "server-only"; client components must not import them.
- [NEXT-005] Server Actions and route handlers return only what the UI needs, never raw records.

## TypeScript (applies to: **/*.ts, **/*.tsx)

- [TS-001] Every promise is awaited or returned; no floating promises.
- [TS-002] No `any` in exported function signatures.
- [TS-003] Use === and !==.
<!-- END:ai-review-rules -->
