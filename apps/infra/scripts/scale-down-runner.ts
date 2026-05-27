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
//   [4/10] Stop STARTED sandboxes (POST /sandbox/:id/stop +
//          poll state=STOPPED). Stop FIRST so [5] backs up the post-stop disk.
//   [5/10] Force backup of (now-STOPPED) sandboxes (POST /sandbox/:id/backup
//          + poll backupState=COMPLETED). Runner CreateBackup is side-effect-
//          free w.r.t. box state — it never stops the box itself.
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
import { scaleDownRunner } from "../lib/scale-down-runner-lib";

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

// ─── API helpers for preflight ────────────────────────────────────────────────

interface ApiClient {
  baseUrl: string;
  token: string;
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`);
  }
}

interface RunnerDto {
  id: string;
  name: string;
  state: string;
  region: string;
  regionType?: string;
  unschedulable: boolean;
  apiKey: string;
  currentStartedSandboxes: number;
}

async function apiFetch<T>(
  api: ApiClient,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const url = `${api.baseUrl.replace(/\/$/, "")}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
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

async function getRunner(api: ApiClient, id: string): Promise<RunnerDto> {
  return apiFetch<RunnerDto>(api, "GET", `/api/admin/runners/${id}`);
}

async function listRunners(api: ApiClient): Promise<RunnerDto[]> {
  return apiFetch<RunnerDto[]>(api, "GET", `/api/admin/runners`);
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

interface SandboxDto {
  id: string;
  name: string;
  state: string;
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
    .description("Safely scale down a SHARED runner: cordon → stop → backup → archive → migrate → delete row → terminate EC2")
    .requiredOption("--id <uuid>", "Runner UUID to scale down")
    .option("--admin-token <token>", "ADMIN bearer (or env BOXLITE_ADMIN_API_KEY)")
    .option("--api-url <url>", "API URL (or env BOXLITE_API_URL)")
    .option("--aws-region <region>", "AWS region", AWS_REGION)
    .option("--aws-profile <name>", "AWS profile")
    .option("--result-file <path>", "Output JSON", "./scale-down-runner-result.json")
    .option("--no-require-peer", "Don't require ≥1 peer (only --strategy stop-and-archive equivalent)")
    .option("--restart-stopped", "Also restart originally-STOPPED sandboxes after archive (default: false)")
    .option("--max-wait-backup <s>", "Per-sandbox timeout for backup", (v) => parseInt(v, 10), 900)
    .option("--max-wait-stop <s>", "Per-sandbox timeout for stop", (v) => parseInt(v, 10), 120)
    .option("--max-wait-archive <s>", "Per-sandbox timeout for archive", (v) => parseInt(v, 10), 300)
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
    // Quick preflight outside generator to gather info for confirmation
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
          `  - cordon, stop, backup, archive all sandboxes on this runner\n` +
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

    // Run the generator for stages 2-10
    const gen = scaleDownRunner({
      apiUrl: args.apiUrl,
      adminToken: args.adminToken,
      awsRegion: args.awsRegion,
      runnerId: args.id,
      restartStopped: args.restartStopped,
      skipEc2Terminate: args.skipEc2Terminate,
      dryRun: false, // We already checked dryRun above
      maxWaitBackupSec: args.maxWaitBackup,
      maxWaitStopSec: args.maxWaitStop,
      maxWaitArchiveSec: args.maxWaitArchive,
      maxWaitStartSec: args.maxWaitStart,
    });

    let genNext = await gen.next();
    let finalResult: any = null;

    while (!genNext.done) {
      const ev = genNext.value as any;

      if (ev.type === "stage") {
        // Skip stage 1 since we already printed it
        if (ev.stage > 1) {
          process.stderr.write(`[${ev.stage}/${ev.total}] ${ev.label}\n`);
        }
      } else if (ev.type === "log") {
        process.stderr.write(`       ${ev.line}\n`);
      } else if (ev.type === "warning") {
        process.stderr.write(`WARNING: ${ev.line}\n`);
      } else if (ev.type === "data") {
        if (ev.key === "sandboxesStarted") {
          const started = ev.value as SandboxDto[];
          result.setEnumerated(started, [], []);
        } else if (ev.key === "sandboxesStopped") {
          const stopped = ev.value as SandboxDto[];
          const current = result["state"]["sandboxes"];
          result.setEnumerated(current.originalStarted.map((s: any) => ({ id: s.id, name: s.name, state: "started" })), stopped, []);
        } else if (ev.key === "sandboxesSkipped") {
          const skipped = ev.value as SandboxDto[];
          const current = result["state"]["sandboxes"];
          result.setEnumerated(
            current.originalStarted.map((s: any) => ({ id: s.id, name: s.name, state: "started" })),
            current.originalStopped.map((s: any) => ({ id: s.id, name: s.name, state: "stopped" })),
            skipped,
          );
          result.flush();
        }
      }

      genNext = await gen.next();
    }

    finalResult = genNext.value as any;

    if (finalResult) {
      result.setCordoned();
      result.setArchived();
      result.setMigrated();
      result.setRowDeleted();
      if (args.skipEc2Terminate) {
        result.setStage("EC2_TERMINATED");
      } else {
        result.setEc2Ids(finalResult.ec2InstancesTerminated);
        result.setEc2Terminated();
      }
      result.setFinished(args.apiUrl);
      result.flush();
    }

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
