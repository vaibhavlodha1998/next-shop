---
name: iac-review
description: Infrastructure as code review checklist (Terraform, Docker, Kubernetes, GitHub Actions).
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/*.{tf,tfvars}", "**/Dockerfile", "**/*.dockerfile", "**/k8s/**/*.{yml,yaml}", "**/helm/**", ".github/workflows/*.{yml,yaml}"]
---
- Public exposure: 0.0.0.0/0 ingress, public buckets, public IPs on internal services.
- Encryption off at rest or in transit; KMS keys not used where the platform expects them.
- IAM: wildcard actions or resources; long-lived access keys instead of roles.
- Containers running as root, `latest` tags, secrets passed as build args.
- Workflows: `pull_request_target` with checkout of PR code; overly broad `permissions`; unpinned third-party actions.
- Missing tags or naming conventions that cost allocation depends on.
