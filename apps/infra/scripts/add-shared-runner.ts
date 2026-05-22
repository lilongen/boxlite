// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Adds one EC2 + registers it as a BoxLite runner in a SHARED region via the
// admin REST API (POST /api/admin/runners). Counterpart of add-runner.ts —
// that one targets per-org CUSTOM regions; this one targets the platform-wide
// SHARED region (default id 'us').
//
// Requires an ADMIN token (the API's ADMIN_API_KEY env, surfaced once in the
// API container's startup log: "Admin user created with API key: ..."; also
// stored as the SST 'AdminApiKey' random in AWS Secrets Manager).
//
// Usage:
//   tsx scripts/add-shared-runner.ts \
//     --admin-token <token> \
//     --api-url https://api.dev.boxlite.ai \
//     --registry-url https://snapshot-manager.dev.boxlite.ai \
//     --subnet-id subnet-... \
//     --instance-profile-name boxlite-RunnerProfile-... \
//     --yes
//
// Env equivalents: BOXLITE_ADMIN_API_KEY, BOXLITE_API_URL, BOXLITE_REGISTRY_URL.

import { writeFileSync } from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

import { Command } from "commander";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  type _InstanceType,
} from "@aws-sdk/client-ec2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CARGO_TOML = path.join(REPO_ROOT, "Cargo.toml");
const AWS_REGION = process.env.AWS_REGION ?? "ap-southeast-1";

export const EXIT = {
  OK: 0,
  TIMEOUT: 1,
  PREFLIGHT: 2,
  API: 3,
  EC2_LAUNCH: 4,
  ARGS: 5,
  REFUSED: 6,
} as const;

// ─── HTTP helpers (admin auth — no X-Organization-Id) ───────────────────────

interface ApiClientOpts {
  baseUrl: string;
  token: string;
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`);
  }
}

async function apiFetch<T>(
  opts: ApiClientOpts,
  method: "GET" | "POST" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
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

// ─── REST data shapes (subset, just what we read) ───────────────────────────

interface CreateRunnerResponseDto {
  id: string;
  name: string;
  apiKey: string;
  region: string;
}

interface RunnerFullDto {
  id: string;
  name: string;
  state: "initializing" | "ready" | "disabled" | "decommissioned" | "unresponsive";
  regionType?: "shared" | "dedicated" | "custom";
}

// ─── Runner apiKey + name helpers ───────────────────────────────────────────

// Match apps/api/src/common/utils/api-key.ts:generateApiKeyValue() format so
// the stored value looks indistinguishable from auto-generated runner keys.
function generateRunnerApiKey(): string {
  return `dtn_${crypto.randomBytes(32).toString("hex")}`;
}

export const RUNNER_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export function validateRunnerName(name: string): void {
  if (!RUNNER_NAME_REGEX.test(name)) {
    throw new Error(`Runner name '${name}' contains invalid chars. Allowed: letters, numbers, _ . -`);
  }
  if (name.length < 2 || name.length > 255) {
    throw new Error(`Runner name '${name}' must be 2–255 chars (got ${name.length}).`);
  }
}

// ─── Admin API calls ────────────────────────────────────────────────────────

// Probe used as preflight to fail fast on bad/missing/wrong-role admin token.
// GET /api/admin/runners is guarded by SystemActionGuard + RequiredApiRole=ADMIN,
// so it returns 401 (no token), 403 (token has wrong role), or 200 (admin).
async function probeAdminAuth(api: ApiClientOpts): Promise<void> {
  await apiFetch<unknown>(api, "GET", `/api/admin/runners`);
}

async function createSharedRunner(
  api: ApiClientOpts,
  input: { regionId: string; name: string; apiKey: string },
): Promise<{ id: string; apiKey: string }> {
  // AdminCreateRunnerDto requires apiKey + apiVersion. For v2 runners the
  // server ignores cpu/memoryGiB/diskGiB/domain/apiUrl/proxyUrl — runner
  // reports those itself via /healthcheck.
  const r = await apiFetch<CreateRunnerResponseDto>(api, "POST", `/api/admin/runners`, {
    name: input.name,
    regionId: input.regionId,
    apiKey: input.apiKey,
    apiVersion: "2",
  });
  if (!r.id) {
    throw new Error(`POST /api/admin/runners returned no id: ${JSON.stringify(r)}`);
  }
  // Server echoes the apiKey we sent (no hashing here). Sanity-check it.
  if (r.apiKey && r.apiKey !== input.apiKey) {
    throw new Error(`Server returned a different apiKey than we sent (unexpected).`);
  }
  return { id: r.id, apiKey: input.apiKey };
}

async function pollUntilReady(
  api: ApiClientOpts,
  runnerId: string,
  timeoutSec: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await apiFetch<RunnerFullDto>(api, "GET", `/api/admin/runners/${runnerId}`);
      if (r.state === "ready") return true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) {
        // transient — keep polling
      } else if (e.status === 404) {
        throw new Error(`Runner ${runnerId} disappeared from API while polling.`);
      } else {
        throw e;
      }
    }
    await new Promise((rs) => setTimeout(rs, 5000));
  }
  return false;
}

// ─── EC2 launch (mirrors sst.config.ts:564-577 default Runner exactly) ──────

const UBUNTU_OWNER_ID = "099720109477";
const UBUNTU_NAME_PATTERN = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";

interface Ec2LaunchInput {
  subnetId: string;
  instanceProfileName: string;
  instanceType: string;
  rootDiskGB: number;
  userDataBase64: string;
  tags: Record<string, string>;
}

interface Ec2LaunchResult {
  instanceId: string;
  publicIp: string | null;
  privateIp: string | null;
  availabilityZone: string | null;
  imageId: string;
}

async function resolveUbuntuAmi(client: EC2Client): Promise<string> {
  const r = await client.send(
    new DescribeImagesCommand({
      Owners: [UBUNTU_OWNER_ID],
      Filters: [
        { Name: "name", Values: [UBUNTU_NAME_PATTERN] },
        { Name: "architecture", Values: ["x86_64"] },
      ],
    }),
  );
  const images = (r.Images ?? []).filter((i) => i.ImageId && i.CreationDate);
  images.sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""));
  if (images.length === 0 || !images[0].ImageId) {
    throw new Error(`No Ubuntu Noble 24.04 AMI found in region.`);
  }
  return images[0].ImageId;
}

async function launchRunnerEc2(client: EC2Client, input: Ec2LaunchInput): Promise<Ec2LaunchResult> {
  const imageId = await resolveUbuntuAmi(client);
  const tagList = Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value }));

  // CpuOptions.NestedVirtualization is required for libkrun/KVM but not yet in
  // @aws-sdk/client-ec2 types (v3.700) — accepted on the wire, cast through any.
  const cpuOptions: any = { NestedVirtualization: "enabled" };

  const run = await client.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: input.instanceType as _InstanceType,
      IamInstanceProfile: { Name: input.instanceProfileName },
      UserData: input.userDataBase64,
      CpuOptions: cpuOptions,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: input.subnetId,
          AssociatePublicIpAddress: true,
        },
      ],
      BlockDeviceMappings: [
        { DeviceName: "/dev/sda1", Ebs: { VolumeSize: input.rootDiskGB } },
      ],
      TagSpecifications: [{ ResourceType: "instance", Tags: tagList }],
      MinCount: 1,
      MaxCount: 1,
    }),
  );

  const instance = run.Instances?.[0];
  if (!instance?.InstanceId) throw new Error("RunInstances returned no instance.");

  let publicIp: string | null = instance.PublicIpAddress ?? null;
  let privateIp: string | null = instance.PrivateIpAddress ?? null;
  let az: string | null = instance.Placement?.AvailabilityZone ?? null;

  for (let i = 0; i < 6; i++) {
    if (publicIp && privateIp && az) break;
    await new Promise((r) => setTimeout(r, 5000));
    const desc = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instance.InstanceId] }),
    );
    const inst = desc.Reservations?.[0]?.Instances?.[0];
    if (!inst) break;
    publicIp = inst.PublicIpAddress ?? publicIp;
    privateIp = inst.PrivateIpAddress ?? privateIp;
    az = inst.Placement?.AvailabilityZone ?? az;
    if (inst.State?.Name === "running") break;
  }

  return { instanceId: instance.InstanceId, publicIp, privateIp, availabilityZone: az, imageId };
}

// ─── Result file ────────────────────────────────────────────────────────────

type RunStatus =
  | "STARTED"
  | "AUTH_VERIFIED"
  | "RUNNER_CREATED"
  | "EC2_LAUNCHED"
  | "READY"
  | "TIMEOUT_WAITING_FOR_READY"
  | "EC2_LAUNCH_FAILED";

interface ResultFile {
  schema_version: 1;
  status: RunStatus;
  runner: {
    id: string | null;
    name: string;
    apiKey: string | null;
    regionId: string;
  };
  region: {
    id: string;
    type: "shared";
  };
  ec2: {
    instanceId: string | null;
    instanceType: string;
    publicIp: string | null;
    privateIp: string | null;
    availabilityZone: string | null;
    launchedAt: string | null;
  };
  timing: {
    startedAt: string;
    authAt: string | null;
    runnerAt: string | null;
    ec2At: string | null;
    readyAt: string | null;
  };
  errors: string[];
  next_steps: string;
}

class ResultWriter {
  private state: ResultFile;
  constructor(
    private readonly path: string,
    initial: { runner: { name: string; regionId: string }; ec2InstanceType: string },
  ) {
    this.state = {
      schema_version: 1,
      status: "STARTED",
      runner: { id: null, name: initial.runner.name, apiKey: null, regionId: initial.runner.regionId },
      region: { id: initial.runner.regionId, type: "shared" },
      ec2: {
        instanceId: null,
        instanceType: initial.ec2InstanceType,
        publicIp: null,
        privateIp: null,
        availabilityZone: null,
        launchedAt: null,
      },
      timing: {
        startedAt: new Date().toISOString(),
        authAt: null,
        runnerAt: null,
        ec2At: null,
        readyAt: null,
      },
      errors: [],
      next_steps: "",
    };
  }
  setAuthVerified() {
    this.state.timing.authAt = new Date().toISOString();
    this.state.status = "AUTH_VERIFIED";
  }
  setRunnerCreated(id: string, apiKey: string) {
    this.state.runner.id = id;
    this.state.runner.apiKey = apiKey;
    this.state.timing.runnerAt = new Date().toISOString();
    this.state.status = "RUNNER_CREATED";
  }
  setEc2Launched(ec2: Partial<ResultFile["ec2"]>) {
    this.state.ec2 = { ...this.state.ec2, ...ec2, launchedAt: new Date().toISOString() };
    this.state.timing.ec2At = new Date().toISOString();
    this.state.status = "EC2_LAUNCHED";
  }
  setReady(apiUrl: string) {
    this.state.timing.readyAt = new Date().toISOString();
    this.state.status = "READY";
    this.state.next_steps =
      `Runner is READY in SHARED region '${this.state.runner.regionId}'.\n` +
      `  Verify:   curl ${apiUrl}/api/admin/runners/${this.state.runner.id} -H 'Authorization: Bearer <admin-token>'\n` +
      `  Drain:    curl -X PATCH ${apiUrl}/api/admin/runners/${this.state.runner.id}/scheduling -H 'Authorization: Bearer <admin-token>' -d '{"unschedulable":true}'\n` +
      `  Delete:   curl -X DELETE ${apiUrl}/api/admin/runners/${this.state.runner.id} -H 'Authorization: Bearer <admin-token>'`;
  }
  setTimeout() {
    this.state.status = "TIMEOUT_WAITING_FOR_READY";
    this.state.next_steps =
      `Runner did not reach READY within timeout. Investigate:\n` +
      `  - EC2 console for instance ${this.state.ec2.instanceId}\n` +
      `  - SSM Run Command: 'sudo journalctl -u boxlite-runner -n 200'`;
  }
  setEc2Failed(apiUrl: string, error: string) {
    this.state.status = "EC2_LAUNCH_FAILED";
    this.state.errors.push(error);
    this.state.next_steps =
      `EC2 launch failed but the runner row exists (orphan). Clean up:\n` +
      `  curl -X DELETE ${apiUrl}/api/admin/runners/${this.state.runner.id} -H 'Authorization: Bearer <admin-token>'`;
  }
  pushError(error: string) { this.state.errors.push(error); }
  flush() { writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 }); }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

interface Args {
  adminToken: string;
  apiUrl: string;
  registryUrl: string;
  subnetId: string;
  instanceProfileName: string;
  regionId: string;
  name?: string;
  apiKey?: string;
  instanceType: string;
  rootDiskGB: number;
  resultFile: string;
  timeout: number;
  noWait: boolean;
  dryRun: boolean;
  yes: boolean;
  awsProfile?: string;
  withBackupSidecar: boolean;
  sidecarPort: number;
  backupsBucket?: string;
}

function parseArgs(): Args {
  const p = new Command();
  p.name("add-shared-runner")
    .description("Add one runner to a SHARED region via POST /api/admin/runners + EC2 RunInstances")
    .option("--admin-token <token>", "ADMIN bearer token (or env BOXLITE_ADMIN_API_KEY)")
    .option("--api-url <url>", "API base URL (or env BOXLITE_API_URL)")
    .option("--registry-url <url>", "Snapshot registry URL (or env BOXLITE_REGISTRY_URL)")
    .option("--subnet-id <id>", "VPC public subnet id for the new EC2")
    .option("--instance-profile-name <name>", "EC2 IAM instance profile name")
    .option("--region-id <id>", "SHARED region id (matches API's DEFAULT_REGION_ID)", "us")
    .option("--name <name>", "Runner name (default: runner-shared-<random6>)")
    .option("--api-key <value>", "Runner apiKey (default: auto-generated dtn_<64hex>). Stored as-is on the runner row.")
    .option("--instance-type <type>", "EC2 instance type", "c8i.2xlarge")
    .option("--root-disk-gb <n>", "EC2 root disk size", (v) => parseInt(v, 10), 100)
    .option("--result-file <path>", "Output JSON", "./add-shared-runner-result.json")
    .option("--timeout <seconds>", "Wait timeout for READY", (v) => parseInt(v, 10), 300)
    .option("--no-wait", "Skip the readiness poll")
    .option("--dry-run", "Print planned actions, no side effects")
    .option("--yes", "Skip interactive confirmation")
    .option("--aws-profile <name>", "AWS profile (overrides AWS_PROFILE)")
    .option("--with-backup-sidecar", "TEST-ONLY: deploy boxlite serve sidecar on :sidecarPort for export/import PoC")
    .option("--sidecar-port <n>", "Sidecar port (default 8080)", (v) => parseInt(v, 10), 8080)
    .option("--backups-bucket <name>", "S3 bucket for .boxlite archives (only with --with-backup-sidecar)")
    .parse();

  const opts = p.opts();
  const adminToken = opts.adminToken ?? process.env.BOXLITE_ADMIN_API_KEY;
  const apiUrl = opts.apiUrl ?? process.env.BOXLITE_API_URL;
  const registryUrl = opts.registryUrl ?? process.env.BOXLITE_REGISTRY_URL;

  if (!adminToken || !apiUrl || !registryUrl || !opts.subnetId || !opts.instanceProfileName) {
    process.stderr.write("ERROR: missing required values. Need (via flag OR env):\n");
    if (!adminToken) process.stderr.write("  --admin-token / BOXLITE_ADMIN_API_KEY\n");
    if (!apiUrl) process.stderr.write("  --api-url / BOXLITE_API_URL\n");
    if (!registryUrl) process.stderr.write("  --registry-url / BOXLITE_REGISTRY_URL\n");
    if (!opts.subnetId) process.stderr.write("  --subnet-id\n");
    if (!opts.instanceProfileName) process.stderr.write("  --instance-profile-name\n");
    process.exit(EXIT.ARGS);
  }

  return {
    adminToken,
    apiUrl,
    registryUrl,
    subnetId: opts.subnetId,
    instanceProfileName: opts.instanceProfileName,
    regionId: opts.regionId,
    name: opts.name,
    apiKey: opts.apiKey,
    instanceType: opts.instanceType,
    rootDiskGB: opts.rootDiskGb,
    resultFile: path.resolve(opts.resultFile),
    timeout: opts.timeout,
    noWait: opts.wait === false,
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
    awsProfile: opts.awsProfile,
    withBackupSidecar: !!opts.withBackupSidecar,
    sidecarPort: opts.sidecarPort,
    backupsBucket: opts.backupsBucket,
  };
}

function defaultName(): string {
  return `runner-shared-${Math.random().toString(36).slice(2, 8)}`;
}

function redactApiKey(key: string): string {
  return key.slice(0, 4) + "…" + key.slice(-4);
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

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs();
  const runnerName = args.name ?? defaultName();
  const runnerApiKey = args.apiKey ?? generateRunnerApiKey();

  try {
    validateRunnerName(runnerName);
  } catch (e: any) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    return EXIT.ARGS;
  }

  if (!process.env.BOXLITE_STAGE) {
    process.stderr.write("ERROR: BOXLITE_STAGE env var must be set (intent guard).\n");
    return EXIT.REFUSED;
  }
  if (args.awsProfile) process.env.AWS_PROFILE = args.awsProfile;

  const api: ApiClientOpts = { baseUrl: args.apiUrl, token: args.adminToken };

  if (!args.yes) {
    const proceed = await confirmTty(
      `About to create SHARED runner '${runnerName}' (${args.instanceType})\n` +
        `  Stack:        ${process.env.BOXLITE_STAGE}\n` +
        `  API:          ${args.apiUrl}\n` +
        `  Region id:    ${args.regionId}  (must already exist as SHARED in the API)\n` +
        `  AWS region:   ${AWS_REGION}\n` +
        `  Subnet:       ${args.subnetId}\n` +
        `  Profile:      ${args.instanceProfileName}\n` +
        `  apiKey:       ${redactApiKey(runnerApiKey)}\n` +
        `  Result file:  ${args.resultFile}\n` +
        `Continue? [y/N] `,
    );
    if (!proceed) {
      process.stderr.write("Aborted by user.\n");
      return EXIT.REFUSED;
    }
  }

  if (args.dryRun) {
    process.stderr.write("\n[DRY RUN] No side effects performed. Exiting.\n");
    return EXIT.OK;
  }

  let result: ResultWriter | null = null;
  let runnerId: string | null = null;

  try {
    // ─── Stage 1: verify admin token by probing /api/admin/runners ─────
    process.stderr.write(`[1/7] Verifying ADMIN token…\n`);
    result = new ResultWriter(args.resultFile, {
      runner: { name: runnerName, regionId: args.regionId },
      ec2InstanceType: args.instanceType,
    });
    result.flush();
    await probeAdminAuth(api);
    result.setAuthVerified();
    result.flush();
    process.stderr.write(`       → ADMIN auth OK\n`);

    // ─── Stage 2: generate runner apiKey (already done above) ──────────
    process.stderr.write(`[2/7] Runner credentials prepared (apiKey ${redactApiKey(runnerApiKey)})…\n`);

    // ─── Stage 3: POST /api/admin/runners ──────────────────────────────
    process.stderr.write(`[3/7] POST /api/admin/runners…\n`);
    const r = await createSharedRunner(api, {
      regionId: args.regionId,
      name: runnerName,
      apiKey: runnerApiKey,
    });
    runnerId = r.id;
    result.setRunnerCreated(r.id, runnerApiKey);
    result.flush();
    process.stderr.write(`       → runner id=${r.id}\n`);

    // ─── Stage 4: build user-data ──────────────────────────────────────
    process.stderr.write(`[4/7] Building EC2 user-data…\n`);
    const { buildRunnerUserData } = await import("../lib/runner-user-data");
    const userDataBase64 = buildRunnerUserData({
      apiUrl: args.apiUrl,
      token: runnerApiKey,
      registryUrl: args.registryUrl,
      runnerPort: 3003,
      withBackupSidecar: args.withBackupSidecar,
      sidecarPort: args.sidecarPort,
      backupsBucket: args.backupsBucket,
      awsRegion: AWS_REGION,
      cargoTomlPath: CARGO_TOML,
    });

    // ─── Stage 5: launch EC2 ───────────────────────────────────────────
    process.stderr.write(`[5/7] Launching EC2…\n`);
    const ec2Client = new EC2Client({ region: AWS_REGION });
    let ec2Result: Ec2LaunchResult;
    try {
      ec2Result = await launchRunnerEc2(ec2Client, {
        subnetId: args.subnetId,
        instanceProfileName: args.instanceProfileName,
        instanceType: args.instanceType,
        rootDiskGB: args.rootDiskGB,
        userDataBase64,
        tags: {
          Name: `boxlite-runner-${runnerId.slice(0, 8)}`,
          RunnerId: runnerId,
          BoxliteOwner: "add-shared-runner-script",
          BoxliteStack: process.env.BOXLITE_STAGE!,
          BoxliteRegion: args.regionId,
        },
      });
    } catch (e: any) {
      result.setEc2Failed(args.apiUrl, e.message ?? String(e));
      result.flush();
      throw e;
    }
    process.stderr.write(`       → instance ${ec2Result.instanceId}, ip=${ec2Result.publicIp ?? "<pending>"}\n`);
    result.setEc2Launched({
      instanceId: ec2Result.instanceId,
      publicIp: ec2Result.publicIp,
      privateIp: ec2Result.privateIp,
      availabilityZone: ec2Result.availabilityZone,
    });
    result.flush();

    // ─── Stage 6: maybe wait ───────────────────────────────────────────
    if (args.noWait) {
      process.stderr.write(`[6/7] Result file written.\n[7/7] --no-wait: skipping readiness poll. Exiting OK.\n`);
      return EXIT.OK;
    }
    process.stderr.write(`[6/7] Result file written. Polling readiness…\n`);

    // ─── Stage 7: poll for READY ───────────────────────────────────────
    process.stderr.write(`[7/7] GET /api/admin/runners/${runnerId} until state=ready (timeout ${args.timeout}s)…\n`);
    const ready = await pollUntilReady(api, runnerId, args.timeout);
    if (ready) {
      result.setReady(args.apiUrl);
      result.flush();
      process.stderr.write(`       → READY. Result file: ${args.resultFile}\n`);
      return EXIT.OK;
    } else {
      result.setTimeout();
      result.flush();
      process.stderr.write(
        `       → TIMEOUT waiting for READY. EC2 + runner row exist; investigate.\n` +
          `       Result file: ${args.resultFile}\n`,
      );
      return EXIT.TIMEOUT;
    }
  } catch (e: any) {
    if (e instanceof ApiError) {
      process.stderr.write(`ERROR (REST): ${e.message}\n`);
      if (e.status === 401) {
        process.stderr.write(
          `       Hint: BOXLITE_ADMIN_API_KEY is missing/expired. Check the API container's startup log\n` +
            `             ("Admin user created with API key: ...") or AWS Secrets Manager 'AdminApiKey'.\n`,
        );
      }
      if (e.status === 403) {
        process.stderr.write(`       Hint: token is valid but lacks ADMIN role.\n`);
      }
      if (e.status === 404 && /Region not found/i.test(e.body)) {
        process.stderr.write(
          `       Hint: region id '${process.argv.includes("--region-id") ? "?" : "us"}' does not exist.\n` +
            `             Confirm the API's DEFAULT_REGION_ID matches --region-id (default 'us').\n`,
        );
      }
      return EXIT.API;
    }
    if (e.message?.includes("RunInstances") || e.message?.includes("AMI")) {
      process.stderr.write(`ERROR (Stage 5 EC2): ${e.message}\n`);
      return EXIT.EC2_LAUNCH;
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
