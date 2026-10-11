# Security Policy

## Supported Versions

| Version         | Supported           |
| --------------- | ------------------- |
| latest (`main`) | ✅                  |
| older releases  | ❌ — please upgrade |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report: **security@opshub.io**

You will receive acknowledgement within **48 hours** and a status update within **7 days**.

## Scope

**In scope:**

- XSS vulnerabilities in the frontend
- Sensitive data (tokens, PII) exposed in source, logs, or network responses
- Insecure storage of credentials (localStorage for JWTs etc.)
- CSRF in form submissions

**Out of scope:**

- Issues requiring physical access
- Social engineering
