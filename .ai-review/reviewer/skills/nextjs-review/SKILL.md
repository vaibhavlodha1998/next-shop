---
name: nextjs-review
description: Review checklist for Next.js App Router code (written against Next.js 16). Loads only when the project depends on next.
metadata:
  version: "1.0.0"
  owner: platform
  requires: ["next"]
  paths: ["**/app/**", "**/pages/**", "**/components/**", "**/proxy.{ts,js}", "**/middleware.{ts,js}", "**/next.config.{ts,js,mjs}", "**/lib/**", "**/actions/**"]
---
Next.js 16 differs from older versions. Judge code against these, not against older habits:

Security boundaries
- A Server Action ("use server") is a public POST endpoint. It must authenticate, authorise and validate its inputs itself. A check in the page that renders the form does not protect the action.
- Route handlers (app/**/route.ts) must check auth before any write, and validate the request body.
- Server Actions and handlers return data to the client: return only what the UI needs, never raw records with internal fields.
- Proxy (proxy.ts, formerly middleware) is an optimistic check only. Real authorisation belongs next to the data.
- Data access and secrets stay in modules marked `import "server-only"`. A "use client" file must not import them.
- Only `NEXT_PUBLIC_*` env vars reach the browser, and they are baked into the bundle: never put secrets in them.

Next.js 16 APIs
- `cookies()`, `headers()`, `draftMode()`, `params` and `searchParams` are async only: they must be awaited (sync access was removed).
- With cacheComponents on, reading request-time data (cookies, headers, params, searchParams, uncached fetch) outside a `<Suspense>` boundary fails the build. Expect Suspense or "use cache".
- `revalidateTag(tag, profile)` needs a second argument; `updateTag(tag)` is for Server Actions only.
- `redirect()` and `notFound()` throw: calling them inside `try { }` swallows the redirect. Call them outside the try block.
- Cookies can only be set in Server Actions or route handlers, not while rendering.

Client and server components
- "use client" only where state, effects or browser APIs are needed; it pulls everything it imports into the client bundle.
- Effects that fetch data on the client where a server component could read it directly.
- Keys from array indexes on lists that reorder; missing loading or error states for async UI.
