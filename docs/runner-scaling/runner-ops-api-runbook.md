# Runner Ops UI Runbook

> Companion to the design spec
> `docs/superpowers/specs/2026-05-25-runner-ops-admin-ui-design.md`
> and the CLI scripts in `apps/infra/scripts/`.

## Audience

Platform operators with `SystemRole.ADMIN` in BoxLite Cloud.

## When to use this UI

- Capacity expansion: add a new SHARED runner without shelling into the build host.
- Capacity reduction: drain and decommission a SHARED runner with live progress visibility.

For CUSTOM (per-org) runners, use the existing `apps/infra/scripts/add-runner.ts` CLI.

## Access

Sign in to the dashboard as a user whose `SystemRole === 'admin'`. The
`Runner Ops` entry appears in the left sidebar under the infrastructure
section, only for admin users. Direct URL: `/dashboard/admin/runner-ops`.

If you reach the URL as a non-admin user, the `RequireAdmin` guard redirects
you to `/dashboard/sandboxes`.

## Add a shared runner

1. Open Dashboard → Runner Ops.
2. Click **+ Add runner**.
3. Optional: set name, region, instance type. Defaults are
   `runner-shared-<rand>`, `us`, `c8i.2xlarge`.
4. Click **Add runner**. The dialog now displays a live log streamed from the
   server-side job record (polled every 2 s).
5. Watch for status `SUCCESS`. The runner takes ~1–3 minutes to reach `READY`;
   the dialog only closes successfully once the lib's readiness poll passes.

If the status reaches `FAILED`, copy the log (everything in the gray box) into
the incident channel and consult the troubleshooting section.

## Scale down a shared runner

1. From the Runner Ops table, click **Scale down** on the row.
2. Optional: tick **Also migrate STOPPED sandboxes** if you want stopped
   sandboxes restarted on peer runners rather than left archived.
3. Click **Scale down**.
4. Watch the 10-stage flow:

   ```text
   [1/10] preflight
   [2/10] cordon source
   [3/10] enumerate sandboxes
   [4/10] stop STARTED sandboxes
   [5/10] backup all sandboxes
   [6/10] archive all
   [7/10] restart on peer
   [8/10] drain wait
   [9/10] delete runner row
   [10/10] terminate EC2
   ```

5. On `SUCCESS`, the row disappears from the table and the EC2 instance is
   terminated.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `409 Conflict` on Add | Another add-shared job is already running | Wait for it to finish; refresh the page. |
| Status `FAILED` at preflight | Runner is not SHARED+READY, or no peer in same region | Verify region/state in the table; you cannot scale down if no peer accepts the boxes. |
| Status `FAILED` at `[5/10] backup` | Backup timed out (default 900 s) | The source remains cordoned. Inspect the sandbox via the existing sandbox detail page, then re-run scale-down via the CLI with `--max-wait-backup 1800`. |
| Status `STALE` | API restarted mid-job | Check EC2 and apps/api state, manually clean up, then re-run. |
| Runner stuck in `INITIALIZING` for >5 min | EC2 user-data failed; runner cannot register | SSH into the EC2 (via `aws ssm start-session`); inspect `journalctl -u boxlite-runner`. |
| 401/403 on the page itself | Logged in as a non-admin user, or token expired | Re-login as a platform admin. |

## CLI escape hatches

Both operations remain available as CLIs. They share the same orchestration
libraries as the UI (`apps/infra/lib/add-shared-runner-lib.ts` and
`apps/infra/lib/scale-down-runner-lib.ts`), so behaviour is identical:

```bash
cd apps/infra
BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> \
  npx tsx scripts/add-shared-runner.ts --name <...> --yes

BOXLITE_ADMIN_API_KEY=<token> AWS_PROFILE=<...> \
  npx tsx scripts/scale-down-runner.ts --id <runner-id> --yes
```

These exhibit identical behaviour to the UI flow and accept extra knobs
(timeouts, `--dry-run`, `--skip-ec2-terminate`). Consult their `--help`.

## Audit trail

Every operation generates entries in the API's audit log (`AuditModule`). Job
records live in Redis for 24 hours under the key prefix `runner-ops:job:`.

## Known limitations (MVP)

- No autoscaling. Operators trigger every action manually.
- No CUSTOM runner UI. Use the CLI for per-org runners.
- One concurrent add + one concurrent scale-down across the platform (Redis
  locks `runner-ops:lock:add-shared` and `runner-ops:lock:scale-down`).
- No SSE; UI polls every 2 s.
- Job records expire after 24 hours.
- Foundation gap: `apps/jest.preset.js` and api-client regen are currently
  broken on this branch (see
  `docs/follow-ups/jest-infra-restore.md`). Unit tests written for the new
  modules will execute once that follow-up lands; for now manual e2e covers
  behavioural verification.
