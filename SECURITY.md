# Security Policy

## Scope

`MonteCarlo-Ledger` is a local-first finance tool. It stores real personal financial records in a
SQLite database at the repository root, and it ships a FastAPI surface that is deliberately
unauthenticated.

Two properties define the current threat model, and reports are most useful when they engage one of
them directly:

1. **Financial data at rest.** `ledger.db` holds transactions, bills, income, and balances in plain
   SQLite. It is gitignored and is expected to stay on the operator's own machine. Anything that
   causes that data to leave the machine, land in a commit, a log line, an error message, or a
   crash report, or be readable by another local user, is in scope.
2. **The local-only API.** The bundled API is intended to be run bound to `127.0.0.1` and has no
   authentication by design. It is not a hardened web service. In scope: a way to make the process
   read or write the ledger without going through the CLI's confirmation and validation path, a
   bypass of the ledger-versus-cached-balance consistency check, or an input that causes the server
   to write to the database.

Out of scope: reports that require the operator to deliberately bind the API to a public interface
(a network-exposed deployment of an unauthenticated local service is a configuration choice, not a
code defect), denial of service from local input, and the security posture of the optional
`MonteCarloLedger-Android` companion app, which is a separate repository.

## Supported Versions

This project is pre-1.0 and is not API-stable.

| Version | Supported |
| --- | --- |
| `master` (latest commit) | Yes |
| Latest tagged release | Yes |
| Any earlier commit, branch, or release | No |

Only the current tip of `master` and the most recent release receive security fixes.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and click
**Report a vulnerability**. This opens a private advisory visible only to the maintainer.

If private reporting is unavailable to your account, open a
[security advisory](https://github.com/gthgomez/MonteCarlo-Ledger/security/advisories/new)
directly. There is no published email address for this project, so the advisory channel is the
supported route.

Please do not open a public issue for an unfixed defect, and do not attach a real `ledger.db` or
any transcript of your own accounts. A synthetic database built with test values is sufficient.

## What to Include

- Type of defect: ledger data escaping its intended local scope, a write path reachable without
  the expected validation or confirmation, a consistency or reconciliation bypass, SQL injection
  through CLI or API input, or a monetary-parsing defect that produces a materially wrong figure.
- Affected commit SHA or release tag, Python version, and SQLite version.
- The CLI invocation or API request that reproduces it, plus the expected and observed result.
- The relevant schema or module path, and confirmation that the reproduction used synthetic data.

## Maintainer Response

The maintainer commits to the following:

- Acknowledge a report within 7 days.
- Provide a severity assessment and a remediation or mitigation plan within 30 days of
  acknowledgement.
- Credit reporters in the advisory and release notes unless anonymity is requested.

Fixes are published on `master` first, then folded into the next release.

## Coordinated Disclosure

Fixes land before public disclosure. A reporter should allow up to 90 days from first contact for
a fix or a documented mitigation before publishing, and the maintainer will not cut that period
short without agreeing with the reporter.

## No Bug Bounty

There is no bug bounty program for this project, and no payment is offered for reports. Credit and
a public advisory are the entire compensation.
