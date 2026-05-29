// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Prepares the test environment for scale-down-runner.ts validation.
//
// Scope (matches user-defined constraint):
//   - SHARED-region runners only (no CUSTOM/DEDICATED).
//   - Box migration boundary = SHARED-to-SHARED.
//
// What it does:
//   1. Resolves r1 (reuses an existing READY shared runner, default `default`).
//   2. Provides r2: either reuse an existing one (--reuse-r2) or provision via
//      add-shared-runner.ts.
//   3. Patches r2's INSECURE_REGISTRIES env (idempotent; harmless on already-fixed).
//   4. Seeds a `snapshot_runner` row with state='ready' for r2 + the chosen
//      snapshot via SSM-RunCommand + psql (the polling cron at
//      snapshot.manager.ts:162 skips READY rows, so the seed persists).
//   5. Places N1 sandboxes on r1 by cordoning r2 during create.
//   6. Places N2 sandboxes on r2 by cordoning r1 during create.
//   7. Writes test-setup-scale-down-result.json with all ids for the
//      downstream scale-down test.
//
// Usage:
//   tsx scripts/test-setup-scale-down.ts \
//     --admin-token <admin-bearer> \
//     --api-url https://api.dev.boxlite.ai \
//     --registry-url https://SnapshotManager-...elb.amazonaws.com \
//     --boxes-per-runner 2 \
//     --yes
//
// Env equivalents: BOXLITE_ADMIN_API_KEY, BOXLITE_API_URL, BOXLITE_REGISTRY_URL.

import { writeFileSync } from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

import { Command } from "commander";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { ECSClient, DescribeServicesCommand, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-1";

export const EXIT = {
  OK: 0,
  TIMEOUT: 1,
  PREFLIGHT: 2,
  API: 3,
  PROVISION: 4,
  ARGS: 5,
  REFUSED: 6,
  DB: 7,
} as const;

// ─── HTTP (admin, no org header — admin context defaults to its personal org) ──

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
  if (!res.ok) {
    throw new ApiError(res.status, text, method, apiPath);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${method} ${apiPath}: ${text.slice(0, 200)}`);
  }
}

// ─── REST shapes (subset, just what we read) ───────────────────────────────────

interface RunnerDto {
  id: string;
  name: string;
  state: "initializing" | "ready" | "disabled" | "decommissioned" | "unresponsive";
  region: string;
  regionType?: "shared" | "dedicated" | "custom";
  unschedulable: boolean;
  apiKey: string;
  domain: string | null;
  cpu: number;
  memory: number;
  disk: number;
}

interface SandboxDto {
  id: string;
  name: string;
  state: string;
  runnerId?: string;
  region?: string;
  snapshot?: string;
}

// ─── AWS helpers ──────────────────────────────────────────────────────────────

async function discoverSsmBastionInstance(awsRegion: string): Promise<string> {
  const ec2 = new EC2Client({ region: awsRegion });
  const r = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: ["boxlite-runner*"] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }),
  );
  const inst = r.Reservations?.[0]?.Instances?.[0];
  if (!inst?.InstanceId) throw new Error("No running boxlite-runner* EC2 to use as SSM/psql bastion.");
  return inst.InstanceId;
}

async function discoverSnapshotManagerAlbDns(awsRegion: string): Promise<string> {
  const elb = new ElasticLoadBalancingV2Client({ region: awsRegion });
  const r = await elb.send(new DescribeLoadBalancersCommand({}));
  const alb = (r.LoadBalancers ?? []).find((lb: any) => lb.DNSName?.includes("napshotMana"));
  if (!alb?.DNSName) throw new Error("Could not find SnapshotManager ALB DNS.");
  return alb.DNSName;
}

interface DbCreds {
  host: string;
  user: string;
  password: string;
  database: string;
  port: string;
}

async function discoverApiDbCreds(awsRegion: string): Promise<DbCreds> {
  const ecsMod = await import("@aws-sdk/client-ecs");
  const ecs = new ECSClient({ region: awsRegion });
  const listClusters = await ecs.send(new ecsMod.ListClustersCommand({}));
  const clusterArn = (listClusters.clusterArns ?? []).find((a: string) => a.includes("boxlite-dev"));
  if (!clusterArn) throw new Error("Could not find boxlite-dev ECS cluster.");

  const svcs = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: ["Api"] }));
  const taskDefArn = svcs.services?.[0]?.taskDefinition;
  if (!taskDefArn) throw new Error("Could not find Api service task definition.");

  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
  const env = (td.taskDefinition?.containerDefinitions?.[0]?.environment ?? []).reduce(
    (acc: Record<string, string>, e) => {
      if (e.name && e.value !== undefined) acc[e.name] = e.value;
      return acc;
    },
    {},
  );

  const required = ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "DB_DATABASE", "DB_PORT"];
  for (const k of required) if (!env[k]) throw new Error(`Missing ${k} in Api task definition env.`);
  return {
    host: env["DB_HOST"],
    user: env["DB_USERNAME"],
    password: env["DB_PASSWORD"],
    database: env["DB_DATABASE"],
    port: env["DB_PORT"],
  };
}

async function ssmRunShell(
  awsRegion: string,
  instanceId: string,
  bashScript: string,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  const ssm = new SSMClient({ region: awsRegion });
  // Encode script as base64 and decode on the remote side to avoid quoting hell
  const b64 = Buffer.from(bashScript).toString("base64");
  const wrapper = `echo '${b64}' | base64 -d | bash`;
  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [wrapper] },
    }),
  );
  const cmdId = send.Command?.CommandId;
  if (!cmdId) throw new Error("SSM SendCommand returned no CommandId.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: cmdId, InstanceId: instanceId }),
      );
      if (inv.Status === "InProgress" || inv.Status === "Pending" || inv.Status === "Delayed") continue;
      if (inv.Status === "Success") {
        return { stdout: inv.StandardOutputContent ?? "", stderr: inv.StandardErrorContent ?? "" };
      }
      throw new Error(
        `SSM command ${cmdId} ended Status=${inv.Status}: ${inv.StandardErrorContent ?? ""}`,
      );
    } catch (e: unknown) {
      // InvocationDoesNotExist while command is still being scheduled — keep polling
      if ((e as { name?: string })?.name === "InvocationDoesNotExist") continue;
      throw e;
    }
  }
  throw new Error(`SSM command ${cmdId} timed out after ${timeoutMs}ms.`);
}

// ─── DB helpers (via SSM-tunneled psql) ──────────────────────────────────────

async function dbExec(
  awsRegion: string,
  bastionInstanceId: string,
  db: DbCreds,
  sql: string,
): Promise<string> {
  const script = `#!/bin/bash
set -euo pipefail
which psql >/dev/null 2>&1 || (sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq postgresql-client >/dev/null)
export PGPASSWORD='${db.password.replace(/'/g, "'\\''")}'
psql -h '${db.host}' -p '${db.port}' -U '${db.user}' -d '${db.database}' -A -F'|' -v ON_ERROR_STOP=1 <<'__SQL__'
${sql}
__SQL__
`;
  const { stdout, stderr } = await ssmRunShell(awsRegion, bastionInstanceId, script);
  if (stderr) console.error(`[dbExec stderr]: ${stderr}`);
  return stdout;
}

async function findSnapshotRefByName(
  awsRegion: string,
  bastionInstanceId: string,
  db: DbCreds,
  snapshotName: string,
): Promise<{ id: string; ref: string; organizationId: string }> {
  const out = await dbExec(
    awsRegion,
    bastionInstanceId,
    db,
    `SELECT id, ref, "organizationId" FROM snapshot WHERE name='${snapshotName}' AND state='active' LIMIT 1;`,
  );
  // Format: header|line + data|line + (1 row)
  const lines = out.split("\n").filter((l) => l && !l.startsWith("("));
  if (lines.length < 2) throw new Error(`Snapshot '${snapshotName}' not found or not active.`);
  const [id, ref, organizationId] = lines[1].split("|");
  if (!ref) throw new Error(`Snapshot row parse error: ${lines[1]}`);
  return { id, ref, organizationId };
}

async function seedSnapshotRunner(
  awsRegion: string,
  bastionInstanceId: string,
  db: DbCreds,
  runnerId: string,
  snapshotRef: string,
): Promise<void> {
  await dbExec(
    awsRegion,
    bastionInstanceId,
    db,
    `INSERT INTO snapshot_runner ("runnerId", "snapshotRef", state)
     VALUES ('${runnerId}', '${snapshotRef.replace(/'/g, "''")}', 'ready')
     ON CONFLICT DO NOTHING;
     SELECT state FROM snapshot_runner WHERE "runnerId"='${runnerId}' AND "snapshotRef"='${snapshotRef.replace(/'/g, "''")}';`,
  );
}

async function ensureAdminQuota(
  awsRegion: string,
  bastionInstanceId: string,
  db: DbCreds,
): Promise<void> {
  // Idempotent: bump admin's personal org quota if currently 0. This is harmless
  // on already-tuned orgs.
  await dbExec(
    awsRegion,
    bastionInstanceId,
    db,
    `UPDATE organization
       SET max_cpu_per_sandbox = GREATEST(max_cpu_per_sandbox, 4),
           max_memory_per_sandbox = GREATEST(max_memory_per_sandbox, 8),
           max_disk_per_sandbox = GREATEST(max_disk_per_sandbox, 10)
       WHERE id IN (SELECT "organizationId" FROM organization_user WHERE "userId"='boxlite-admin');`,
  );
}

// ─── INSECURE_REGISTRIES fix on a runner (idempotent) ──────────────────────────

async function ensureInsecureRegistries(
  awsRegion: string,
  runnerInstanceId: string,
  albDns: string,
): Promise<void> {
  const script = `#!/bin/bash
set -euo pipefail
UNIT=/etc/systemd/system/boxlite-runner.service
WANT_HOST="${albDns}"
CURRENT=$(grep -E '^Environment=INSECURE_REGISTRIES=' "$UNIT" 2>/dev/null | head -1 | cut -d= -f3-)
if [ "$CURRENT" = "$WANT_HOST" ]; then
  echo "INSECURE_REGISTRIES already correct: $CURRENT"
  exit 0
fi
sudo sed -i "s|Environment=INSECURE_REGISTRIES=.*|Environment=INSECURE_REGISTRIES=$WANT_HOST|" "$UNIT"
sudo systemctl daemon-reload
sudo systemctl restart boxlite-runner
echo "INSECURE_REGISTRIES updated to: $WANT_HOST"
`;
  const { stdout } = await ssmRunShell(awsRegion, runnerInstanceId, script);
  process.stderr.write(`       ${stdout.trim()}\n`);
}

// ─── Runner ops ───────────────────────────────────────────────────────────────

async function getRunner(api: ApiClient, id: string): Promise<RunnerDto> {
  return apiFetch<RunnerDto>(api, "GET", `/api/admin/runners/${id}`);
}

async function listRunners(api: ApiClient): Promise<RunnerDto[]> {
  return apiFetch<RunnerDto[]>(api, "GET", `/api/admin/runners`);
}

async function setScheduling(api: ApiClient, id: string, unschedulable: boolean): Promise<void> {
  await apiFetch<unknown>(api, "PATCH", `/api/admin/runners/${id}/scheduling`, { unschedulable });
}

async function waitRunnerReady(api: ApiClient, id: string, timeoutSec: number): Promise<RunnerDto> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await getRunner(api, id);
    if (r.state === "ready") return r;
    await new Promise((rs) => setTimeout(rs, 5000));
  }
  throw new Error(`Runner ${id} did not become ready within ${timeoutSec}s.`);
}

// ─── Sandbox ops ──────────────────────────────────────────────────────────────

async function createSandbox(
  api: ApiClient,
  input: { name: string; snapshot: string; target: string },
): Promise<SandboxDto> {
  const body = {
    target: input.target,
    snapshot: input.snapshot,
    name: input.name,
    autoStopInterval: 30,
    autoArchiveInterval: 60,
    autoDeleteInterval: -1,
  };
  return apiFetch<SandboxDto>(api, "POST", `/api/sandbox`, body);
}

async function getSandbox(api: ApiClient, id: string): Promise<SandboxDto> {
  return apiFetch<SandboxDto>(api, "GET", `/api/sandbox/${id}`);
}

async function waitSandboxStarted(api: ApiClient, id: string, timeoutSec: number): Promise<SandboxDto> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: SandboxDto | null = null;
  while (Date.now() < deadline) {
    last = await getSandbox(api, id);
    if (last.state === "started") return last;
    if (last.state === "error" || last.state === "build_failed") {
      throw new Error(`Sandbox ${id} entered terminal state ${last.state}.`);
    }
    await new Promise((rs) => setTimeout(rs, 3000));
  }
  throw new Error(`Sandbox ${id} not started within ${timeoutSec}s (last state=${last?.state}).`);
}

async function destroySandbox(api: ApiClient, id: string): Promise<void> {
  try {
    await apiFetch<unknown>(api, "DELETE", `/api/sandbox/${id}`);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
}

// ─── Placement primitive: place sandbox on a specific runner via cordon-others ─

async function placeBoxesOnRunner(
  api: ApiClient,
  targetRunnerId: string,
  snapshot: string,
  region: string,
  count: number,
  namePrefix: string,
): Promise<SandboxDto[]> {
  // Cordon every other ready, schedulable shared runner in same region
  const all = await listRunners(api);
  const peers = all.filter(
    (r) =>
      r.id !== targetRunnerId &&
      r.region === region &&
      r.regionType === "shared" &&
      r.state === "ready" &&
      !r.unschedulable,
  );
  const cordonedIds: string[] = [];

  try {
    for (const p of peers) {
      await setScheduling(api, p.id, true);
      cordonedIds.push(p.id);
    }

    const created: SandboxDto[] = [];
    for (let i = 0; i < count; i++) {
      const sb = await createSandbox(api, {
        target: region,
        snapshot,
        name: `${namePrefix}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
      });
      if (sb.runnerId !== targetRunnerId) {
        throw new Error(
          `Sandbox ${sb.id} landed on runner ${sb.runnerId}, expected ${targetRunnerId} (cordon failed?).`,
        );
      }
      created.push(sb);
    }
    return created;
  } finally {
    // Always restore — even on partial failure
    for (const id of cordonedIds) {
      try {
        await setScheduling(api, id, false);
      } catch (e) {
        process.stderr.write(`       WARN: failed to uncordon ${id}: ${e}\n`);
      }
    }
  }
}

// ─── Provision r2 via add-shared-runner.ts subprocess ─────────────────────────

async function provisionR2(
  args: Args,
  name: string,
): Promise<{ id: string; apiKey: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        path.join(__dirname, "add-shared-runner.ts"),
        "--admin-token",
        args.adminToken,
        "--api-url",
        args.apiUrl,
        "--registry-url",
        args.registryUrl,
        "--subnet-id",
        args.subnetId,
        "--instance-profile-name",
        args.instanceProfileName,
        "--region-id",
        args.region,
        "--name",
        name,
        "--result-file",
        path.join(__dirname, "..", "test-setup-r2-result.json"),
        "--yes",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env },
      },
    );
    child.on("error", reject);
    child.on("exit", async (code) => {
      if (code !== 0) {
        reject(new Error(`add-shared-runner.ts exited with code ${code}`));
        return;
      }
      try {
        const { readFileSync } = await import("fs");
        const result = JSON.parse(
          readFileSync(path.join(__dirname, "..", "test-setup-r2-result.json"), "utf-8"),
        );
        if (!result.runner?.id || !result.runner?.apiKey) {
          reject(new Error("add-shared-runner.ts result missing runner.id/apiKey"));
          return;
        }
        resolve({ id: result.runner.id, apiKey: result.runner.apiKey });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ─── Result file ──────────────────────────────────────────────────────────────

interface ResultFile {
  schema_version: 1;
  status: "STARTED" | "READY" | "FAILED";
  region: string;
  snapshot: { name: string; ref: string };
  r1: { id: string; name: string; sandboxes: { id: string; name: string }[] };
  r2: { id: string; name: string; sandboxes: { id: string; name: string }[]; provisionedByThisRun: boolean };
  startedAt: string;
  readyAt: string | null;
  errors: string[];
  next_steps: string;
}

class ResultWriter {
  private state: ResultFile;
  constructor(
    private readonly path: string,
    init: { region: string; snapshotName: string; snapshotRef: string },
  ) {
    this.state = {
      schema_version: 1,
      status: "STARTED",
      region: init.region,
      snapshot: { name: init.snapshotName, ref: init.snapshotRef },
      r1: { id: "", name: "", sandboxes: [] },
      r2: { id: "", name: "", sandboxes: [], provisionedByThisRun: false },
      startedAt: new Date().toISOString(),
      readyAt: null,
      errors: [],
      next_steps: "",
    };
  }
  setR1(id: string, name: string) { this.state.r1.id = id; this.state.r1.name = name; }
  setR2(id: string, name: string, provisioned: boolean) {
    this.state.r2.id = id;
    this.state.r2.name = name;
    this.state.r2.provisionedByThisRun = provisioned;
  }
  setR1Boxes(boxes: SandboxDto[]) {
    this.state.r1.sandboxes = boxes.map((b) => ({ id: b.id, name: b.name }));
  }
  setR2Boxes(boxes: SandboxDto[]) {
    this.state.r2.sandboxes = boxes.map((b) => ({ id: b.id, name: b.name }));
  }
  setReady(apiUrl: string) {
    this.state.status = "READY";
    this.state.readyAt = new Date().toISOString();
    this.state.next_steps =
      `Test env ready. Next:\n` +
      `  npx tsx scripts/scale-down-runner.ts --id ${this.state.r2.id} --yes\n` +
      `Verify migration:\n` +
      `  for sid in ${this.state.r2.sandboxes.map((s) => s.id).join(" ")}; do\n` +
      `    curl -s ${apiUrl}/api/sandbox/$sid -H 'Authorization: Bearer <admin>' | jq '{id,state,runnerId}'\n` +
      `  done`;
  }
  fail(reason: string) {
    this.state.status = "FAILED";
    this.state.errors.push(reason);
  }
  flush() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  adminToken: string;
  apiUrl: string;
  registryUrl: string;
  subnetId: string;
  instanceProfileName: string;
  region: string;
  snapshotName: string;
  boxesPerRunner: number;
  reuseR1: string | undefined;
  reuseR2: string | undefined;
  r2Name: string;
  resultFile: string;
  awsRegion: string;
  awsProfile?: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const p = new Command();
  p.name("test-setup-scale-down")
    .description("Sets up r1+r2 in SHARED region + boxes on both, for scale-down E2E testing")
    .option("--admin-token <token>", "ADMIN bearer token (or env BOXLITE_ADMIN_API_KEY)")
    .option("--api-url <url>", "API URL (or env BOXLITE_API_URL)")
    .option("--registry-url <url>", "SnapshotManager ALB URL (or env BOXLITE_REGISTRY_URL)")
    .option("--subnet-id <id>", "VPC subnet for r2 provisioning (or auto-discover)")
    .option("--instance-profile-name <name>", "EC2 IAM profile for r2 (or auto-discover)")
    .option("--region <id>", "SHARED region id", "us")
    .option("--snapshot <name>", "Snapshot name", "ubuntu-dev")
    .option("--boxes-per-runner <n>", "Boxes to create on EACH runner", (v) => parseInt(v, 10), 2)
    .option("--reuse-r1 <id>", "Reuse an existing shared runner as r1 (default: pick 'default')")
    .option("--reuse-r2 <id>", "Reuse an existing shared runner as r2 (default: provision new)")
    .option("--r2-name <name>", "Name for r2 if provisioning", `r2-${Math.random().toString(36).slice(2, 7)}`)
    .option("--result-file <path>", "Output JSON", "./test-setup-scale-down-result.json")
    .option("--aws-region <region>", "AWS region", AWS_REGION)
    .option("--aws-profile <name>", "AWS profile")
    .option("--dry-run", "Print plan, no side effects")
    .option("--yes", "Skip interactive confirmation")
    .parse();
  const opts = p.opts();
  const adminToken = opts.adminToken ?? process.env.BOXLITE_ADMIN_API_KEY;
  const apiUrl = opts.apiUrl ?? process.env.BOXLITE_API_URL;
  const registryUrl = opts.registryUrl ?? process.env.BOXLITE_REGISTRY_URL;
  if (!adminToken || !apiUrl || !registryUrl) {
    process.stderr.write("ERROR: missing required values:\n");
    if (!adminToken) process.stderr.write("  --admin-token / BOXLITE_ADMIN_API_KEY\n");
    if (!apiUrl) process.stderr.write("  --api-url / BOXLITE_API_URL\n");
    if (!registryUrl) process.stderr.write("  --registry-url / BOXLITE_REGISTRY_URL\n");
    process.exit(EXIT.ARGS);
  }
  return {
    adminToken,
    apiUrl,
    registryUrl,
    subnetId: opts.subnetId ?? "",
    instanceProfileName: opts.instanceProfileName ?? "",
    region: opts.region,
    snapshotName: opts.snapshot,
    boxesPerRunner: opts.boxesPerRunner,
    reuseR1: opts.reuseR1,
    reuseR2: opts.reuseR2,
    r2Name: opts.r2Name,
    resultFile: path.resolve(opts.resultFile),
    awsRegion: opts.awsRegion,
    awsProfile: opts.awsProfile,
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
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

async function autodiscoverR2InfraDefaults(awsRegion: string): Promise<{ subnetId: string; instanceProfileName: string }> {
  const ec2 = new EC2Client({ region: awsRegion });
  const r = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: ["boxlite-runner*"] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }),
  );
  const inst = r.Reservations?.[0]?.Instances?.[0];
  if (!inst?.SubnetId) throw new Error("Could not auto-discover subnet for r2 provisioning.");
  const profileArn = inst.IamInstanceProfile?.Arn;
  if (!profileArn) throw new Error("Could not auto-discover IAM instance profile.");
  return {
    subnetId: inst.SubnetId,
    instanceProfileName: profileArn.split("/").pop()!,
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs();
  if (args.awsProfile) process.env.AWS_PROFILE = args.awsProfile;

  const api: ApiClient = { baseUrl: args.apiUrl, token: args.adminToken };
  let result: ResultWriter | null = null;

  try {
    // ─── [1/8] Preflight + discovery ─────────────────────────────────────
    process.stderr.write(`[1/8] Preflight + discovery…\n`);
    process.stderr.write(`       awsRegion=${args.awsRegion}  apiUrl=${args.apiUrl}\n`);

    // Verify admin auth
    await apiFetch<unknown>(api, "GET", `/api/admin/runners`);
    process.stderr.write(`       ✓ admin auth OK\n`);

    // Auto-discover infra if not provided
    if (!args.subnetId || !args.instanceProfileName) {
      const auto = await autodiscoverR2InfraDefaults(args.awsRegion);
      if (!args.subnetId) args.subnetId = auto.subnetId;
      if (!args.instanceProfileName) args.instanceProfileName = auto.instanceProfileName;
      process.stderr.write(`       ✓ infra: subnet=${args.subnetId} profile=${args.instanceProfileName}\n`);
    }

    // Discover bastion + db + snapshot ref
    const bastion = await discoverSsmBastionInstance(args.awsRegion);
    const db = await discoverApiDbCreds(args.awsRegion);
    const albDns = await discoverSnapshotManagerAlbDns(args.awsRegion);
    process.stderr.write(`       ✓ bastion=${bastion}\n`);
    process.stderr.write(`       ✓ db=${db.host}:${db.port}/${db.database}\n`);
    process.stderr.write(`       ✓ snapshot-mgr ALB=${albDns}\n`);

    // Ensure admin quota (idempotent)
    await ensureAdminQuota(args.awsRegion, bastion, db);

    // Resolve snapshot
    const snap = await findSnapshotRefByName(args.awsRegion, bastion, db, args.snapshotName);
    process.stderr.write(`       ✓ snapshot ${args.snapshotName}: id=${snap.id.slice(0, 8)}…\n`);

    result = new ResultWriter(args.resultFile, {
      region: args.region,
      snapshotName: args.snapshotName,
      snapshotRef: snap.ref,
    });
    result.flush();

    // ─── [2/8] Resolve r1 (existing) ─────────────────────────────────────
    process.stderr.write(`[2/8] Resolving r1…\n`);
    const allRunners = await listRunners(api);
    let r1: RunnerDto | undefined;
    if (args.reuseR1) {
      r1 = allRunners.find((r) => r.id === args.reuseR1);
      if (!r1) throw new Error(`Runner --reuse-r1=${args.reuseR1} not found.`);
    } else {
      r1 = allRunners.find(
        (r) =>
          r.name === "default" &&
          r.region === args.region &&
          r.regionType === "shared" &&
          r.state === "ready",
      );
      if (!r1) throw new Error(`No 'default' SHARED ready runner in region ${args.region}. Pass --reuse-r1.`);
    }
    if (r1.regionType !== "shared") throw new Error(`r1 must be SHARED, got ${r1.regionType}.`);
    if (r1.state !== "ready") throw new Error(`r1 must be ready, got ${r1.state}.`);
    process.stderr.write(`       ✓ r1=${r1.name} (${r1.id})\n`);
    result.setR1(r1.id, r1.name);
    result.flush();

    if (args.dryRun) {
      process.stderr.write(`[dry-run] would provision/reuse r2, seed snapshot, place ${args.boxesPerRunner}+${args.boxesPerRunner} boxes. Exiting.\n`);
      return EXIT.OK;
    }

    if (!args.yes) {
      const proceed = await confirmTty(
        `\nAbout to:\n` +
          `  - ensure r2 exists (reuse=${args.reuseR2 ?? "(none → will provision new)"})\n` +
          `  - seed snapshot ${args.snapshotName} on r2 + fix INSECURE_REGISTRIES\n` +
          `  - place ${args.boxesPerRunner} sandboxes on r1 (cordoning r2)\n` +
          `  - place ${args.boxesPerRunner} sandboxes on r2 (cordoning r1)\n` +
          `  - result file: ${args.resultFile}\n` +
          `Continue? [y/N] `,
      );
      if (!proceed) {
        process.stderr.write("Aborted by user.\n");
        return EXIT.REFUSED;
      }
    }

    // ─── [3/8] Provide r2 ────────────────────────────────────────────────
    process.stderr.write(`[3/8] Providing r2…\n`);
    let r2: RunnerDto | undefined;
    let r2Provisioned = false;
    if (args.reuseR2) {
      r2 = allRunners.find((r) => r.id === args.reuseR2);
      if (!r2) throw new Error(`Runner --reuse-r2=${args.reuseR2} not found.`);
      if (r2.regionType !== "shared") throw new Error(`r2 must be SHARED, got ${r2.regionType}.`);
      if (r2.region !== args.region) throw new Error(`r2 region=${r2.region}, expected ${args.region}.`);
      if (r2.state !== "ready") {
        process.stderr.write(`       waiting for r2 to be ready…\n`);
        r2 = await waitRunnerReady(api, r2.id, 300);
      }
      process.stderr.write(`       ✓ reusing r2=${r2.name} (${r2.id})\n`);
    } else {
      process.stderr.write(`       provisioning r2='${args.r2Name}'…\n`);
      const provisioned = await provisionR2(args, args.r2Name);
      r2Provisioned = true;
      r2 = await getRunner(api, provisioned.id);
      if (r2.regionType !== "shared") throw new Error(`Newly provisioned r2 regionType=${r2.regionType}; expected shared.`);
      process.stderr.write(`       ✓ r2=${r2.name} (${r2.id})\n`);
    }
    result.setR2(r2.id, r2.name, r2Provisioned);
    result.flush();

    // ─── [4/8] Fix INSECURE_REGISTRIES on r2 ─────────────────────────────
    process.stderr.write(`[4/8] Ensuring r2 INSECURE_REGISTRIES=${albDns}…\n`);
    // Find the r2 EC2 by RunnerId tag
    const ec2 = new EC2Client({ region: args.awsRegion });
    const ec2Resp = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:RunnerId", Values: [r2.id] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      }),
    );
    const r2Inst = ec2Resp.Reservations?.[0]?.Instances?.[0]?.InstanceId;
    if (r2Inst) {
      await ensureInsecureRegistries(args.awsRegion, r2Inst, albDns);
      // Wait for re-ready (restart may briefly take r2 out of READY)
      process.stderr.write(`       waiting for r2 to return to ready…\n`);
      r2 = await waitRunnerReady(api, r2.id, 120);
    } else {
      process.stderr.write(`       WARN: no EC2 with tag:RunnerId=${r2.id} found; skipping INSECURE fix\n`);
    }

    // ─── [5/8] Seed snapshot_runner row state=ready for r2 ───────────────
    process.stderr.write(`[5/8] Seeding snapshot_runner row state=ready for r2…\n`);
    await seedSnapshotRunner(args.awsRegion, bastion, db, r2.id, snap.ref);
    process.stderr.write(`       ✓ seeded\n`);

    // r1 may be a freshly-provisioned runner (--reuse-r1) rather than the
    // long-lived `default` (which already has the snapshot cached). A fresh
    // runner has no snapshot_runner row, so the scheduler's availability gate
    // would reject placement onto it. Seed r1 too (idempotent ON CONFLICT).
    // INSECURE_REGISTRIES is already correct on a runner provisioned by
    // add-shared-runner (it derives it from the same SnapshotManager ALB DNS).
    if (args.reuseR1) {
      process.stderr.write(`[5b/8] Seeding snapshot_runner row state=ready for r1 (reused/fresh)…\n`);
      await seedSnapshotRunner(args.awsRegion, bastion, db, r1.id, snap.ref);
      process.stderr.write(`       ✓ seeded r1\n`);
    }

    // ─── [6/8] Place N boxes on r1 ───────────────────────────────────────
    process.stderr.write(`[6/8] Placing ${args.boxesPerRunner} boxes on r1=${r1.name}…\n`);
    const r1Boxes = await placeBoxesOnRunner(api, r1.id, args.snapshotName, args.region, args.boxesPerRunner, "test-r1");
    process.stderr.write(`       created ${r1Boxes.length}: ${r1Boxes.map((b) => b.id.slice(0, 8)).join(", ")}\n`);
    result.setR1Boxes(r1Boxes);
    result.flush();

    process.stderr.write(`       waiting for r1 boxes to start…\n`);
    const r1Started: SandboxDto[] = [];
    for (const b of r1Boxes) r1Started.push(await waitSandboxStarted(api, b.id, 120));
    process.stderr.write(`       ✓ all ${r1Started.length} r1 boxes STARTED\n`);

    // ─── [7/8] Place N boxes on r2 ───────────────────────────────────────
    process.stderr.write(`[7/8] Placing ${args.boxesPerRunner} boxes on r2=${r2.name}…\n`);
    const r2Boxes = await placeBoxesOnRunner(api, r2.id, args.snapshotName, args.region, args.boxesPerRunner, "test-r2");
    process.stderr.write(`       created ${r2Boxes.length}: ${r2Boxes.map((b) => b.id.slice(0, 8)).join(", ")}\n`);
    result.setR2Boxes(r2Boxes);
    result.flush();

    process.stderr.write(`       waiting for r2 boxes to start…\n`);
    const r2Started: SandboxDto[] = [];
    for (const b of r2Boxes) r2Started.push(await waitSandboxStarted(api, b.id, 240));
    process.stderr.write(`       ✓ all ${r2Started.length} r2 boxes STARTED\n`);

    // ─── [8/8] Done ──────────────────────────────────────────────────────
    process.stderr.write(`[8/8] Test env ready. Result file: ${args.resultFile}\n`);
    result.setReady(args.apiUrl);
    result.flush();
    return EXIT.OK;
  } catch (e: any) {
    if (result) {
      result.fail(e?.message ?? String(e));
      result.flush();
    }
    if (e instanceof ApiError) {
      process.stderr.write(`ERROR (REST): ${e.message}\n`);
      return EXIT.API;
    }
    process.stderr.write(`ERROR: ${e?.stack ?? e}\n`);
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
