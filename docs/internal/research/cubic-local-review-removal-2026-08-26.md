# Cubic local review removal

## Decision

EVB Viewer uses CodeRabbit as its only required independent reviewer. The local
Cubic commit-review wrapper, repository configuration, and policy references
were removed. Ox Alpha is no longer part of the default review workflow.

## Evidence

- Cubic's current documentation calls the CLI review a lightweight local pass
  and documents `cubic review --commit <ref> --output-format stream-json` as the
  supported integration command. The removed wrapper used that exact command.
  Source: https://docs.cubic.dev/ide/cli-review
- Both the Mac and VPS reported Cubic 1.10.5. `cubic upgrade` reported 1.10.5 as
  current on both hosts, so the failure was not an outdated client.
- On the Mac, the current release commit completed in 38 seconds. Replaying
  commit `86b74b83aff99ccbf4d2cd5d75617273de163ede` produced normal progress and
  heartbeats but no terminal event within a 120-second diagnostic bound. The
  original review of the same commit reached the repository's 600-second bound
  without a terminal event.
- The VPS installation reported zero credentials. Its Cubic lane could not
  review changes and could only take the fail-open path.
- The project ledger records earlier 600-second timeouts and contradictory
  findings. Those historical entries remain unchanged as audit evidence.

Raising the timeout would make publication slower without making the reviewer
reliable. The wrapper parsed successful terminal events correctly, so changing
its event handling would not address the failure.
