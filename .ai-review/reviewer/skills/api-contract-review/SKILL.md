---
name: api-contract-review
description: Review checklist for public API contracts (OpenAPI, protobuf, route handlers).
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/openapi*.{yml,yaml,json}", "**/swagger*.{yml,yaml,json}", "**/*.proto", "**/routes/**", "**/controllers/**", "**/api/**"]
---
- Breaking changes: removed or renamed fields, changed types, new required request fields, changed status codes.
- New endpoints without input validation, auth, pagination or rate limiting where the convention requires them.
- Error responses that leak stack traces or internal ids.
- Version not bumped when the contract changes.
