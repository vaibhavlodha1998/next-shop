---
name: security-review
description: Security checklist for application and infrastructure code. Owned by the security team; changes need their approval.
metadata:
  version: "1.0.0"
  owner: security
  paths: ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,kt,go,rb,php,cs,sql,tf,yml,yaml}", "**/Dockerfile"]
---
Look for:
- Injection: SQL, shell, LDAP or template strings built from request data. Parameterise instead.
- Auth: endpoints or handlers added without an auth check; role checks done on the client only.
- Secrets: credentials, tokens or keys in code or config (the scanner catches most; flag hard-coded test credentials that look real).
- Unsafe deserialisation, eval, exec, pickle, yaml.load without a safe loader, dangerouslySetInnerHTML with user data.
- Logging of personal data, tokens, passwords or full request bodies.
- Crypto: MD5 or SHA1 for passwords, home-made crypto, Math.random for tokens, disabled TLS verification.
- SSRF and path traversal: user input used in URLs or file paths without an allow list.

Mark a finding "critical" only when it is exploitable as written (for example, raw SQL built from a request parameter).
