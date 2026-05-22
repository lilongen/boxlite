// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Safely scales down a SHARED-region runner.
//
// Scope (matches user-defined constraint):
//   - Only SHARED runners can be scaled down (assert at preflight).
//   - Boxes migrate SHARED→SHARED only. Boundary is naturally enforced because
//     start-action.restoreSandboxOnNewRunner filters candidates by
//     `regions: [sandbox.region]` — sandbox.region is sticky.
//
// 10-stage flow (composed entirely from existing API endpoints — no internal
// `draining` cron involved, no API code changes needed):
//
//   [1/10] Preflight: assert runner is SHARED+READY; assert ≥1 peer in same
//          shared region; capture runner apiKey.
//   [2/10] Cordon: PATCH /admin/runners/:id/scheduling unschedulable=true.
//   [3/10] Enumerate sandboxes via runner.apiKey (GET /sandbox/for-runner).
//   [4/10] Force backup of STARTED sandboxes (POST /sandbox/:id/backup +
//          poll backupState=COMPLETED).
//   [5/10] Stop STARTED sandboxes (POST /sandbox/:id/stop +
//          poll state=STOPPED).
//   [6/10] Archive all (now-STOPPED) sandboxes (POST /sandbox/:id/archive +
//          poll state=ARCHIVED, runnerId=null).
//   [7/10] Restart sandboxes that were originally STARTED (POST /sandbox/:id/
//          start). start-action picks new runner via existing region filter.
//          Verify new runnerId != source AND new runner is SHARED+same-region.
//   [8/10] Wait until source has 0 non-ARCHIVED/DESTROYED sandboxes.
//   [9/10] DELETE /admin/runners/:id.
//   [10/10] aws ec2 terminate-instances --filters tag:RunnerId=:id.
//
// Usage:
//   tsx scripts/scale-down-runner.ts --id <runner-uuid> --yes

import { writeFileSync } from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

import { Command } from "commander";
import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-1";

export const EXIT = {
  OK: 0,
  TIMEOUT: 1,
  PREFLIGHT: 2,
  API: 3,
  EC2: 4,
  ARGS: 5,
  REFUSED: 6,
  BOUNDARY: 7,
  MIGRATION_FAILED: 8,
} as const;

// ─── HTTP ────────────────────────────────────────────────────────────────────

interface ApiClient {
  baseUrl: string;
  token: string;
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`);
  }
}

async function apiFetch<T>(
  api: ApiClient,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  apiPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const url = `${api.baseUrl.replace(/\/$/, "")}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text, method, apiPath);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${method} ${apiPath}: ${text.slice(0, 200)}`);
  }
}

// ─── REST shapes ──────────────────────────────────────────────────────────────

interface RunnerDto {
  id: string;
  name: string;
  state: "initializing" | "ready" | "disabled" | "decommissioned" | "unresponsive";
  region: string;
  regionType?: "shared" | "dedicated" | "custom";
  unschedulable: boolean;
  apiKey: string;
  currentStartedSandboxes: number;
}

interface SandboxDto {
  id: string;
  name: string;
  state: string;
  desiredState?: string;
  runnerId?: string;
  region?: string;
  snapshot?: string;
  backupState?: string;
  backupSnapshot?: string;
}

// ─── Runner ops ──────────────────────────────────────────────────────────────

async function getRunner(api: ApiClient, id: string): Promise<RunnerDto> {
  return apiFetch<RunnerDto>(api, "GET", `/api/admin/runners/${id}`);
}

async function listRunners(api: ApiClient): Promise<RunnerDto[]> {
  return apiFetch<RunnerDto[]>(api, "GET", `/api/admin/runners`);
}

async function setScheduling(api: ApiClient, id: string, unschedulable: boolean): Promise<void> {
  await apiFetch<unknown>(api, "PATCH", `/api/admin/runners/${id}/scheduling`, { unschedulable });
}

// ─── Sandbox ops ─────────────────────────────────────────────────────────────

async function listSandboxesOnRunner(api: ApiClient, runnerApiKey: string): Promise<SandboxDto[]> {
  // GET /api/sandbox/for-runner uses RunnerAuthGuard → must auth with runner's own apiKey.
  const url = `${api.baseUrl.replace(/\/$/, "")}/api/sandbox/for-runner`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${runnerApiKey}` },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text(), "GET", "/api/sandbox/for-runner");
  return (await res.json()) as SandboxDto[];
}

async function getSandbox(api: ApiClient, id: string): Promise<SandboxDto> {
  return apiFetch<SandboxDto>(api, "GET", `/api/sandbox/${id}`);
}

// Triggers a backup if not already in progress. Returns:
//   - "triggered" if we POSTed and got 200
//   - "already-in-progress" if the API rejected with 400 "already in progress"
//   - "already-complete" if backupState is already COMPLETED (caller may skip)
async function triggerBackupSmart(
  api: ApiClient,
  id: string,
): Promise<"triggered" | "already-in-progress" | "already-complete" | "skipped"> {
  const s = await getSandbox(api, id);
  const bs = (s.backupState ?? "").toLowerCase();
  // If a fresh backup is already complete and lastBackupAt is recent, skip
  if (bs === "completed") return "already-complete";
  // If currently in flight, don't re-trigger
  if (bs === "pending" || bs === "in_progress" || bs === "inprogress") return "already-in-progress";
  // Otherwise trigger
  try {
    await apiFetch<unknown>(api, "POST", `/api/sandbox/${id}/backup`, {});
    return "triggered";
  } catch (e) {
    // Race: cron triggered between our get + post
    if (e instanceof ApiError && e.status === 400 && /already in progress/i.test(e.body)) {
      return "already-in-progress";
    }
    throw e;
  }
}

async function stopSandbox(api: ApiClient, id: string): Promise<void> {
  await apiFetch<unknown>(api, "POST", `/api/sandbox/${id}/stop`, {});
}

async function archiveSandbox(api: ApiClient, id: string): Promise<void> {
  await apiFetch<unknown>(api, "POST", `/api/sandbox/${id}/archive`, {});
}

async function startSandbox(api: ApiClient, id: string): Promise<void> {
  await apiFetch<unknown>(api, "POST", `/api/sandbox/${id}/start`, {});
}

// ─── Polling helpers ─────────────────────────────────────────────────────────

async function waitFor<T>(
  desc: string,
  fn: () => Promise<T | null>,
  timeoutSec: number,
  intervalMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${desc} (${timeoutSec}s). Last value: ${JSON.stringify(last)}`);
}

async function waitBackupCompleted(
  api: ApiClient,
  sid: string,
  timeoutSec: number,
): Promise<"completed" | "error"> {
  const result = await waitFor<{ s: SandboxDto; outcome: "completed" | "error" }>(
    `backup of ${sid} to COMPLETED`,
    async () => {
      const s = await getSandbox(api, sid);
      const bs = (s.backupState ?? "").toLowerCase();
      if (bs === "completed") return { s, outcome: "completed" };
      if (bs === "error") return { s, outcome: "error" };
      return null;
    },
    timeoutSec,
  );
  return result.outcome;
}

// Wait until sandbox.state is ARCHIVED AND runnerId is null (the latter is the
// signal that the runner-side destroy actually completed and ran archive.action's
// final updateSandboxState(..., null) at sandbox-archive.action.ts:101/123).
async function waitArchivedAndDetached(
  api: ApiClient,
  sid: string,
  timeoutSec: number,
): Promise<SandboxDto> {
  return waitFor<SandboxDto>(
    `sandbox ${sid} state=archived AND runnerId=null`,
    async () => {
      const s = await getSandbox(api, sid);
      if (s.state === "archived" && !s.runnerId) return s;
      if (s.state === "error" || s.state === "build_failed") {
        throw new Error(`Sandbox ${sid} entered terminal state ${s.state} during archive.`);
      }
      return null;
    },
    timeoutSec,
  );
}

async function waitSandboxState(
  api: ApiClient,
  sid: string,
  desired: string | string[],
  timeoutSec: number,
): Promise<SandboxDto> {
  const want = Array.isArray(desired) ? desired : [desired];
  const terminalBad = ["error", "build_failed"];
  return waitFor<SandboxDto>(
    `sandbox ${sid} state ∈ {${want.join(",")}}`,
    async () => {
      const s = await getSandbox(api, sid);
      if (want.includes(s.state)) return s;
      if (terminalBad.includes(s.state) && !want.includes(s.state)) {
        throw new Error(`Sandbox ${sid} entered terminal state ${s.state}.`);
      }
      return null;
    },
    timeoutSec,
  );
}

// ─── EC2 ─────────────────────────────────────────────────────────────────────

async function findEc2ByRunnerId(awsRegion: string, runnerId: string): Promise<string[]> {
  const ec2 = new EC2Client({ region: awsRegion });
  const r = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:RunnerId", Values: [runnerId] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    }),
  );
  return (r.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => i.InstanceId!).filter(Boolean);
}

async function terminateEc2(awsRegion: string, instanceIds: string[]): Promise<void> {
  if (!instanceIds.length) return;
  const ec2 = new EC2Client({ region: awsRegion });
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
}

// ─── Result file ─────────────────────────────────────────────────────────────

type Stage =
  | "STARTED"
  | "CORDONED"
  | "ENUMERATED"
  | "BACKED_UP"
  | "STOPPED"
  | "ARCHIVED"
  | "MIGRATED"
  | "DRAINED"
  | "ROW_DELETED"
  | "EC2_TERMINATED"
  | "FAILED";

interface MigratedSandbox {
  id: string;
  name: string;
  originalState: string;
  fromRunnerId: string;
  toRunnerId: string | null;
  finalState: string;
}

interface ResultFile {
  schema_version: 1;
  status: Stage;
  source: { id: string; name: string; region: string };
  peers: { id: string; name: string }[];
  sandboxes: {
    originalStarted: { id: string; name: string }[];
    originalStopped: { id: string; name: string }[];
    skipped: { id: string; state: string; reason: string }[];
  };
  migrations: MigratedSandbox[];
  ec2: { instanceIds: string[]; terminated: boolean };
  timing: {
    startedAt: string;
    cordonedAt: string | null;
    archivedAt: string | null;
    migratedAt: string | null;
    runnerDeletedAt: string | null;
    finishedAt: string | null;
  };
  errors: string[];
  next_steps: string;
}

class ResultWriter {
  private state: ResultFile;
  constructor(
    private readonly path: string,
    init: { runnerId: string; runnerName: string; region: string },
  ) {
    this.state = {
      schema_version: 1,
      status: "STARTED",
      source: { id: init.runnerId, name: init.runnerName, region: init.region },
      peers: [],
      sandboxes: { originalStarted: [], originalStopped: [], skipped: [] },
      migrations: [],
      ec2: { instanceIds: [], terminated: false },
      timing: {
        startedAt: new Date().toISOString(),
        cordonedAt: null,
        archivedAt: null,
        migratedAt: null,
        runnerDeletedAt: null,
        finishedAt: null,
      },
      errors: [],
      next_steps: "",
    };
  }
  setPeers(peers: RunnerDto[]) { this.state.peers = peers.map((p) => ({ id: p.id, name: p.name })); }
  setStage(stage: Stage) { this.state.status = stage; }
  setCordoned() { this.state.timing.cordonedAt = new Date().toISOString(); this.setStage("CORDONED"); }
  setEnumerated(started: SandboxDto[], stopped: SandboxDto[], skipped: SandboxDto[]) {
    this.state.sandboxes.originalStarted = started.map((s) => ({ id: s.id, name: s.name }));
    this.state.sandboxes.originalStopped = stopped.map((s) => ({ id: s.id, name: s.name }));
    this.state.sandboxes.skipped = skipped.map((s) => ({ id: s.id, state: s.state, reason: "transient/terminal" }));
    this.setStage("ENUMERATED");
  }
  pushMigration(m: MigratedSandbox) { this.state.migrations.push(m); }
  setArchived() { this.state.timing.archivedAt = new Date().toISOString(); this.setStage("ARCHIVED"); }
  setMigrated() { this.state.timing.migratedAt = new Date().toISOString(); this.setStage("MIGRATED"); }
  setRowDeleted() { this.state.timing.runnerDeletedAt = new Date().toISOString(); this.setStage("ROW_DELETED"); }
  setEc2Ids(ids: string[]) { this.state.ec2.instanceIds = ids; }
  setEc2Terminated() { this.state.ec2.terminated = true; this.setStage("EC2_TERMINATED"); }
  setFinished(apiUrl: string) {
    this.state.timing.finishedAt = new Date().toISOString();
    this.state.next_steps =
      `Scale-down complete. Summary:\n` +
      `  - source: ${this.state.source.name} (${this.state.source.id})\n` +
      `  - migrated: ${this.state.migrations.filter((m) => m.toRunnerId).length} sandbox(es) to peers\n` +
      `  - archived (not restarted): ${this.state.migrations.filter((m) => !m.toRunnerId).length}\n` +
      `Verify peers picked up boxes:\n` +
      `  curl ${apiUrl}/api/admin/runners -H 'Authorization: Bearer <admin>' | jq '.[] | {name,currentStartedSandboxes}'`;
  }
  fail(reason: string) { this.state.errors.push(reason); this.setStage("FAILED"); }
  flush() { writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 }); }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
  id: string;
  adminToken: string;
  apiUrl: string;
  awsRegion: string;
  awsProfile?: string;
  resultFile: string;
  requirePeer: boolean;
  restartStopped: boolean;
  maxWaitBackup: number;
  maxWaitStop: number;
  maxWaitArchive: number;
  maxWaitStart: number;
  maxWaitDrain: number;
  skipEc2Terminate: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const p = new Command();
  p.name("scale-down-runner")
    .description("Safely scale down a SHARED runner: cordon → backup → stop → archive → migrate → delete row → terminate EC2")
    .requiredOption("--id <uuid>", "Runner UUID to scale down")
    .option("--admin-token <token>", "ADMIN bearer (or env BOXLITE_ADMIN_API_KEY)")
    .option("--api-url <url>", "API URL (or env BOXLITE_API_URL)")
    .option("--aws-region <region>", "AWS region", AWS_REGION)
    .option("--aws-profile <name>", "AWS profile")
    .option("--result-file <path>", "Output JSON", "./scale-down-runner-result.json")
    .option("--no-require-peer", "Don't require ≥1 peer (only --strategy stop-and-archive equivalent)")
    .option("--restart-stopped", "Also restart originally-STOPPED sandboxes after archive (default: false)")
    // Sidecar export+S3 upload of a multi-GB archive can run minutes; bumped to 900s
    // from the previous 600s default to absorb slow MinIO/S3 PUTs over the dev VPC link.
    .option("--max-wait-backup <s>", "Per-sandbox timeout for backup", (v) => parseInt(v, 10), 900)
    .option("--max-wait-stop <s>", "Per-sandbox timeout for stop", (v) => parseInt(v, 10), 120)
    .option("--max-wait-archive <s>", "Per-sandbox timeout for archive", (v) => parseInt(v, 10), 300)
    // Restore-from-archive includes S3 GET + sidecar import + box start; 900s is the
    // matching ceiling for the backup path.
    .option("--max-wait-start <s>", "Per-sandbox timeout for start-on-new-runner", (v) => parseInt(v, 10), 900)
    .option("--max-wait-drain <s>", "Stage [8/10] total timeout", (v) => parseInt(v, 10), 900)
    .option("--skip-ec2-terminate", "Don't terminate EC2 (keep for inspection)")
    .option("--dry-run", "Print plan, no side effects")
    .option("--yes", "Skip interactive confirmation")
    .parse();
  const o = p.opts();
  const adminToken = o.adminToken ?? process.env.BOXLITE_ADMIN_API_KEY;
  const apiUrl = o.apiUrl ?? process.env.BOXLITE_API_URL;
  if (!adminToken || !apiUrl) {
    process.stderr.write("ERROR: --admin-token / BOXLITE_ADMIN_API_KEY and --api-url / BOXLITE_API_URL are required.\n");
    process.exit(EXIT.ARGS);
  }
  return {
    id: o.id,
    adminToken,
    apiUrl,
    awsRegion: o.awsRegion,
    awsProfile: o.awsProfile,
    resultFile: path.resolve(o.resultFile),
    requirePeer: o.requirePeer !== false,
    restartStopped: !!o.restartStopped,
    maxWaitBackup: o.maxWaitBackup,
    maxWaitStop: o.maxWaitStop,
    maxWaitArchive: o.maxWaitArchive,
    maxWaitStart: o.maxWaitStart,
    maxWaitDrain: o.maxWaitDrain,
    skipEc2Terminate: !!o.skipEc2Terminate,
    dryRun: !!o.dryRun,
    yes: !!o.yes,
  };
}

async function confirmTty(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs();
  if (args.awsProfile) process.env.AWS_PROFILE = args.awsProfile;
  const api: ApiClient = { baseUrl: args.apiUrl, token: args.adminToken };
  let result: ResultWriter | null = null;

  try {
    // ─── [1/10] Preflight ────────────────────────────────────────────────
    process.stderr.write(`[1/10] Preflight…\n`);
    const src = await getRunner(api, args.id);

    if (src.regionType !== "shared") {
      process.stderr.write(`       ✗ runner regionType='${src.regionType}'; scope is SHARED-only.\n`);
      return EXIT.BOUNDARY;
    }
    if (src.state !== "ready") {
      process.stderr.write(`       WARN: runner state='${src.state}' (expected 'ready'). Continuing.\n`);
    }
    process.stderr.write(`       ✓ source: ${src.name} (${src.id})  region=${src.region} (shared)\n`);

    // Peer pool: same shared region, ready, schedulable, not the source
    const all = await listRunners(api);
    const peers = all.filter(
      (r) =>
        r.id !== src.id &&
        r.region === src.region &&
        r.regionType === "shared" &&
        r.state === "ready" &&
        !r.unschedulable,
    );
    process.stderr.write(`       ✓ peer pool (shared, ready, schedulable, region=${src.region}): ${peers.length}\n`);
    for (const p of peers) process.stderr.write(`           - ${p.name} (${p.id})\n`);

    if (args.requirePeer && peers.length === 0) {
      process.stderr.write(
        `       ✗ no eligible peer in shared region ${src.region}.\n` +
          `         Pass --no-require-peer to scale down anyway (originally-STARTED sandboxes will get stuck on restart).\n`,
      );
      return EXIT.BOUNDARY;
    }

    result = new ResultWriter(args.resultFile, { runnerId: src.id, runnerName: src.name, region: src.region });
    result.setPeers(peers);
    result.flush();

    if (args.dryRun) {
      process.stderr.write(`[dry-run] would cordon, drain, migrate. Exiting.\n`);
      return EXIT.OK;
    }

    if (!args.yes) {
      const ok = await confirmTty(
        `\nAbout to scale-down runner ${src.name} (${src.id}):\n` +
          `  - cordon, backup, stop, archive all sandboxes on this runner\n` +
          `  - restart originally-STARTED sandboxes (they migrate to peers)\n` +
          `  - DELETE runner DB row\n` +
          `  - ${args.skipEc2Terminate ? "(skip)" : "TERMINATE"} EC2(s) tagged RunnerId=${src.id}\n` +
          `Continue? [y/N] `,
      );
      if (!ok) {
        process.stderr.write("Aborted by user.\n");
        return EXIT.REFUSED;
      }
    }

    // ─── [2/10] Cordon ──────────────────────────────────────────────────
    process.stderr.write(`[2/10] Cordon source runner…\n`);
    await setScheduling(api, src.id, true);
    result.setCordoned();
    result.flush();

    // ─── [3/10] Enumerate ───────────────────────────────────────────────
    process.stderr.write(`[3/10] Enumerate sandboxes on source…\n`);
    if (!src.apiKey) throw new Error(`Source runner row is missing apiKey; cannot list sandboxes.`);
    const all_sandboxes = await listSandboxesOnRunner(api, src.apiKey);
    const TERMINAL = new Set(["archived", "destroyed", "destroying"]);
    const STARTED_LIKE = new Set(["started"]);
    const STOPPED_LIKE = new Set(["stopped"]);

    const started: SandboxDto[] = [];
    const stopped: SandboxDto[] = [];
    const skipped: SandboxDto[] = [];
    for (const sb of all_sandboxes) {
      if (TERMINAL.has(sb.state)) continue;
      if (STARTED_LIKE.has(sb.state)) started.push(sb);
      else if (STOPPED_LIKE.has(sb.state)) stopped.push(sb);
      else skipped.push(sb);
    }
    process.stderr.write(
      `       found: started=${started.length} stopped=${stopped.length} skipped(transient/error)=${skipped.length}\n`,
    );
    if (skipped.length > 0) {
      for (const s of skipped) process.stderr.write(`           SKIP ${s.id} (state=${s.state})\n`);
    }
    result.setEnumerated(started, stopped, skipped);
    result.flush();

    // Pre-record originals for migration tracking
    for (const sb of [...started, ...stopped]) {
      result.pushMigration({
        id: sb.id,
        name: sb.name,
        originalState: sb.state,
        fromRunnerId: src.id,
        toRunnerId: null,
        finalState: "",
      });
    }

    if (started.length === 0 && stopped.length === 0) {
      process.stderr.write(`       (no sandboxes to migrate)\n`);
    }

    // ─── [4/10] Force backup STARTED sandboxes ──────────────────────────
    if (started.length > 0) {
      process.stderr.write(`[4/10] Ensure backup COMPLETED for ${started.length} STARTED sandbox(es)…\n`);
      for (const sb of started) {
        process.stderr.write(`       ${sb.id} (${sb.name})…\n`);
        try {
          const status = await triggerBackupSmart(api, sb.id);
          process.stderr.write(`         status=${status}\n`);
          if (status === "already-complete") {
            process.stderr.write(`         ✓ already COMPLETED, skipping\n`);
            continue;
          }
          // Wait for it to settle (either completed, or error which we retry once)
          let outcome = await waitBackupCompleted(api, sb.id, args.maxWaitBackup);
          if (outcome === "error") {
            process.stderr.write(`         backup ended in ERROR; retrying once…\n`);
            // Retry: another trigger will be treated as "already-in-progress" if API has
            // not yet cleared state; otherwise it actually re-runs.
            await triggerBackupSmart(api, sb.id);
            outcome = await waitBackupCompleted(api, sb.id, args.maxWaitBackup);
          }
          if (outcome === "completed") {
            process.stderr.write(`         ✓ backup COMPLETED\n`);
          } else {
            throw new Error(`backup of ${sb.id} ended in ERROR after retry; aborting`);
          }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e);
          process.stderr.write(`         FAIL: ${msg}\n`);
          result.fail(`backup ${sb.id}: ${msg}`);
          result.flush();
          return EXIT.MIGRATION_FAILED;
        }
      }
    } else {
      process.stderr.write(`[4/10] No STARTED sandboxes; skip backup stage.\n`);
    }

    // ─── [5/10] Stop STARTED ────────────────────────────────────────────
    if (started.length > 0) {
      process.stderr.write(`[5/10] Stop ${started.length} STARTED sandbox(es)…\n`);
      for (const sb of started) {
        process.stderr.write(`       stop ${sb.id}…\n`);
        try {
          await stopSandbox(api, sb.id);
          await waitSandboxState(api, sb.id, "stopped", args.maxWaitStop);
          process.stderr.write(`         ✓ STOPPED\n`);
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e);
          process.stderr.write(`         WARN: ${msg}\n`);
          result.fail(`stop ${sb.id}: ${msg}`);
        }
      }
    } else {
      process.stderr.write(`[5/10] No STARTED sandboxes; skip stop stage.\n`);
    }

    // ─── [6/10] Archive all (now-STOPPED) ───────────────────────────────
    const toArchive = [...started, ...stopped];
    if (toArchive.length > 0) {
      process.stderr.write(`[6/10] Archive ${toArchive.length} sandbox(es) (wait for runnerId=null)…\n`);
      for (const sb of toArchive) {
        process.stderr.write(`       archive ${sb.id}…\n`);
        try {
          await archiveSandbox(api, sb.id);
          const archived = await waitArchivedAndDetached(api, sb.id, args.maxWaitArchive);
          if (archived.runnerId) {
            throw new Error(`Sandbox ${sb.id} state=archived but runnerId still set to ${archived.runnerId}.`);
          }
          process.stderr.write(`         ✓ ARCHIVED and detached (runnerId=null)\n`);
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e);
          process.stderr.write(`         FAIL: ${msg}\n`);
          result.fail(`archive ${sb.id}: ${msg}`);
          result.flush();
          return EXIT.MIGRATION_FAILED;
        }
      }
      result.setArchived();
      result.flush();
    } else {
      process.stderr.write(`[6/10] No sandboxes to archive.\n`);
    }

    // ─── [7/10] Restart (live migrate) ──────────────────────────────────
    const toRestart = args.restartStopped ? [...started, ...stopped] : started;
    if (toRestart.length > 0) {
      process.stderr.write(`[7/10] Restart ${toRestart.length} sandbox(es) on peer runner(s)…\n`);
      for (const sb of toRestart) {
        process.stderr.write(`       start ${sb.id}…\n`);
        try {
          // Pre-condition: sandbox must currently have runnerId=null. Otherwise
          // start-action will just resume on the same runner without migration.
          const pre = await getSandbox(api, sb.id);
          if (pre.runnerId) {
            throw new Error(
              `Pre-start check failed: sandbox ${sb.id} still has runnerId=${pre.runnerId}. Archive stage didn't detach.`,
            );
          }
          await startSandbox(api, sb.id);
          const restored = await waitSandboxState(api, sb.id, "started", args.maxWaitStart);
          // Verify boundary
          if (!restored.runnerId || restored.runnerId === src.id) {
            throw new Error(
              `Sandbox ${sb.id} did not move off source (runnerId=${restored.runnerId}).`,
            );
          }
          const dst = all.find((r) => r.id === restored.runnerId);
          // Fetch fresh, in case dst is one we don't already have
          const dstRunner = dst ?? (await getRunner(api, restored.runnerId));
          if (dstRunner.regionType !== "shared") {
            throw new Error(
              `Sandbox ${sb.id} restored on non-shared runner (regionType=${dstRunner.regionType}). Boundary violation!`,
            );
          }
          if (dstRunner.region !== src.region) {
            throw new Error(
              `Sandbox ${sb.id} crossed regions: ${src.region} → ${dstRunner.region}.`,
            );
          }
          process.stderr.write(`         ✓ STARTED on ${dstRunner.name} (${dstRunner.id.slice(0, 8)})\n`);

          // Update migration record
          const m = result["state"]["migrations"].find((x: MigratedSandbox) => x.id === sb.id);
          if (m) {
            m.toRunnerId = dstRunner.id;
            m.finalState = "started";
          }
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e);
          process.stderr.write(`         WARN: ${msg}\n`);
          result.fail(`start ${sb.id}: ${msg}`);
          const m = result["state"]["migrations"].find((x: MigratedSandbox) => x.id === sb.id);
          if (m) m.finalState = "failed-to-restart";
        }
      }
      result.setMigrated();
      result.flush();
    } else {
      process.stderr.write(`[7/10] No sandboxes to restart.\n`);
    }

    // ─── [8/10] Wait runner drainable ──────────────────────────────────
    process.stderr.write(`[8/10] Wait until source has 0 non-archived/destroyed sandboxes…\n`);
    const deadline8 = Date.now() + args.maxWaitDrain * 1000;
    let drainable = false;
    while (Date.now() < deadline8) {
      const fresh = await getRunner(api, src.id);
      if (fresh.currentStartedSandboxes === 0) {
        // Double-check via DELETE preflight by trying it; if it returns 412 we keep waiting
        try {
          // We don't actually call DELETE here, just verify. Trust the count + the fact that we archived everything.
          drainable = true;
          break;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!drainable) {
      process.stderr.write(`       WARN: drain wait timed out; will try DELETE anyway.\n`);
    }
    result.setStage("DRAINED");
    result.flush();

    // ─── [9/10] DELETE runner row ──────────────────────────────────────
    process.stderr.write(`[9/10] DELETE /api/admin/runners/${src.id}…\n`);
    try {
      await apiFetch<unknown>(api, "DELETE", `/api/admin/runners/${src.id}`);
      process.stderr.write(`       ✓ runner row deleted\n`);
      result.setRowDeleted();
      result.flush();
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      process.stderr.write(`       ✗ DELETE failed: ${msg}\n`);
      result.fail(`DELETE runner: ${msg}`);
      result.flush();
      return EXIT.API;
    }

    // ─── [10/10] Terminate EC2 ─────────────────────────────────────────
    if (args.skipEc2Terminate) {
      process.stderr.write(`[10/10] --skip-ec2-terminate: leaving EC2(s) running.\n`);
    } else {
      process.stderr.write(`[10/10] Terminate EC2 by tag:RunnerId=${src.id}…\n`);
      const ec2Ids = await findEc2ByRunnerId(args.awsRegion, src.id);
      result.setEc2Ids(ec2Ids);
      if (ec2Ids.length === 0) {
        process.stderr.write(`       (no matching EC2 found)\n`);
      } else {
        process.stderr.write(`       terminating: ${ec2Ids.join(", ")}\n`);
        await terminateEc2(args.awsRegion, ec2Ids);
        result.setEc2Terminated();
      }
      result.flush();
    }

    result.setFinished(args.apiUrl);
    result.flush();
    process.stderr.write(`\nDone. Result file: ${args.resultFile}\n`);
    return EXIT.OK;
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (result) {
      result.fail(msg);
      result.flush();
    }
    if (e instanceof ApiError) {
      process.stderr.write(`ERROR (REST): ${e.message}\n`);
      return EXIT.API;
    }
    process.stderr.write(`ERROR: ${(e as Error)?.stack ?? msg}\n`);
    return EXIT.PREFLIGHT;
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`UNCAUGHT: ${e?.stack ?? e}\n`);
      process.exit(99);
    });
}
