# VPS cross-box transport research

Date: 2026-09-09 UTC

## Finding

The Mac could reach the VPS over Tailscale, but Fail2Ban was rejecting the
Mac's Tailscale IPv4 address on TCP port 22. The T3 backend and WebSocket
gateway were not broken. They bind to loopback, so direct connections to
`100.80.25.36:3774` and `100.80.25.36:3775` are expected to refuse.

## Evidence

- The VPS Tailscale address is `100.80.25.36`; the Mac peer is
  `100.72.92.101`.
- Tailscale ICMP and routing worked in both directions.
- On the VPS, `sshd` listened on `0.0.0.0:22` and `[::]:22`.
- The VPS packet capture showed the Mac's SYN packets arriving on
  `tailscale0`. The VPS returned the TCP reset for port 22 before the fix.
- The live nftables rules contained a Fail2Ban set with
  `100.72.92.101`, followed by a reject rule for TCP port 22:

  ```text
  tcp dport 22 ip saddr @addr-set-sshd reject with icmp port-unreachable
  ```

- Fail2Ban's log recorded three `Invalid user evb` attempts from
  `100.72.92.101` at 20:59 UTC, then banned that address. The Mac-side
  dispatcher uses `ubuntu@100.80.25.36` for VPS access, so those earlier
  `evb` attempts came from an older or incorrect invocation.
- Tailscale Serve listeners on ports 443, 8443, and 47723 accepted TCP
  connections. Curling those listeners by IP failed TLS hostname selection,
  which is expected. Use the VPS Tailscale hostname when testing HTTPS.

## Repair

The VPS was changed in two scoped steps:

1. Added `100.72.92.101` to the running `sshd` jail ignore list.
2. Removed the existing live ban, then persisted the exception in
   `/etc/fail2ban/jail.local`.

The Fail2Ban configuration test and reload both succeeded. No T3 worker,
existing worktree, or active writer was stopped or settled. No VPS refill was
dispatched.

## Verification

From the Mac after the repair:

- Three TCP probes to `100.80.25.36:22` succeeded.
- SSH reached the OpenSSH 9.6 banner, completed key exchange and public-key
  authentication, and ran `true` with exit code 0.
- `~/bin/t3-agent --host vps ls` returned the VPS registry.
- A real Mac-originated `t3-agent --host vps new` using the stable task key
  `mac-to-vps-transport-probe-20260909` created VPS thread
  `a4f3e73d-b078-4131-8b1a-c15319eefa0f`. The child completed and returned its
  answer to the Mac supervisor. The probe created no files.

The final VPS checks show:

- `fail2ban-client -t`: configuration test successful.
- The `sshd` ignore list contains `100.72.92.101`.
- The active Fail2Ban reject set contains other banned addresses but not the
  Mac address.
- The disposable probe thread and its linked worktree were removed after the
  successful check.

## Operating rule

Mac-to-VPS T3 commands should use the dispatcher path that SSHes to
`ubuntu@100.80.25.36` over Tailscale. Do not treat the loopback-only ports
3774 and 3775 as Mac-facing health checks. If Fail2Ban is changed later,
preserve the Mac Tailscale address in the `sshd` jail ignore list or a single
set of failed authentication attempts can cut off the dispatcher again.
