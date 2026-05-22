// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
//
// Adds one EC2 + registers it as a BoxLite runner via the REST API
// (org-scoped CUSTOM region only — SHARED runners are out of scope).
//
// Talks to apps/api over HTTPS instead of the database directly. This avoids
// any need for SSM tunnels, RDS credentials, or psql — but requires the org
// to have the ORGANIZATION_INFRASTRUCTURE feature flag enabled and an API
// token with WRITE_REGIONS + WRITE_RUNNERS permissions.
//
// Usage:
//   tsx scripts/add-runner.ts \
//     --orgid <uuid> \
//     --api-token <token> \
//     --api-url https://api.dev.boxlite.ai \
//     --registry-url https://snapshot-manager.dev.boxlite.ai \
//     --subnet-id subnet-... \
//     --instance-profile-name boxlite-RunnerProfile-... \
//     --yes
//
// See: docs/superpowers/specs/2026-05-21-add-runner-script-design.md
// See: apps/infra/scripts/README.md

import { writeFileSync } from "fs";
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

// ─── HTTP helpers ───────────────────────────────────────────────────────────

interface ApiClientOpts {
  baseUrl: string;
  token: string;
  orgId: string;
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, method: string, path: string) {
    super(`API ${method} ${path} → ${status}: ${body.slice(0, 500)}`);
  }
}

async function apiFetch<T>(
  opts: ApiClientOpts,
  method: "GET" | "POST",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "X-Organization-Id": opts.orgId,
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

interface RegionDto {
  id: string;
  name: string;
  regionType: "shared" | "dedicated" | "custom";
  organizationId: string | null;
}

interface CreateRunnerResponseDto {
  id: string;
  name: string;
  apiKey: string;
  region: string;
}

interface RunnerDto {
  id: string;
  name: string;
  state: "initializing" | "ready" | "disabled" | "decommissioned" | "unresponsive";
}

// ─── Region resolution via REST ─────────────────────────────────────────────

export interface ResolvedRegion {
  id: string;
  name: string;
  type: "custom";
  organizationId: string;
  createdByThisScript: boolean;
}

export async function resolveRegion(
  api: ApiClientOpts,
  args: { orgId: string; regionId?: string; regionName?: string },
): Promise<ResolvedRegion> {
  // Case B: explicit region id — find-or-create with that exact id.
  //   • GET /api/regions/<id>  → if 200, validate ownership/type, use it
  //   • If 404, POST /api/regions { id, name } to create it with that id.
  //     Works because apps/api's ValidationPipe is `{ transform: true }`
  //     (no whitelist), so the extra `id` field passes through to the
  //     Region entity constructor: `if (params.id) this.id = params.id`.
  if (args.regionId) {
    try {
      const r = await apiFetch<RegionDto>(api, "GET", `/api/regions/${args.regionId}`);
      if (r.organizationId !== args.orgId) {
        throw new Error(`Region ${args.regionId} belongs to org '${r.organizationId}', not '${args.orgId}'.`);
      }
      if (r.regionType !== "custom" && r.regionType !== "dedicated") {
        throw new Error(`Region ${args.regionId} has type '${r.regionType}'; expected 'custom' or 'dedicated'.`);
      }
      return {
        id: r.id,
        name: r.name,
        type: "custom",
        organizationId: args.orgId,
        createdByThisScript: false,
      };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      // 404: fall through to create with explicit id
    }
    const createName = args.regionName ?? args.regionId;
    const created = await apiFetch<RegionDto>(api, "POST", `/api/regions`, {
      id: args.regionId,
      name: createName,
    });
    return {
      id: created.id,
      name: created.name,
      type: "custom",
      organizationId: args.orgId,
      createdByThisScript: true,
    };
  }

  // Case C: find-or-create CUSTOM region. Default name is 'us' (override with
  // --region-name). The (organizationId, name) unique index means each org
  // gets its own 'us' row — no collision across orgs.
  const wantedName = args.regionName ?? "us";

  // List available regions for the org and look for our target name
  const existing = await apiFetch<RegionDto[]>(api, "GET", `/api/regions`);
  const match = existing.find(
    (r) => r.name === wantedName && r.organizationId === args.orgId && r.regionType === "custom",
  );
  if (match) {
    return {
      id: match.id,
      name: match.name,
      type: "custom",
      organizationId: args.orgId,
      createdByThisScript: false,
    };
  }

  // Create it. POST /api/regions hardcodes regionType=custom + organizationId=authContext.org.
  const created = await apiFetch<RegionDto>(api, "POST", `/api/regions`, { name: wantedName });
  return {
    id: created.id,
    name: created.name,
    type: "custom",
    organizationId: args.orgId,
    createdByThisScript: true,
  };
}

// ─── Runner creation via REST ──────────────────────────────────────────────

export const RUNNER_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

export function validateRunnerName(name: string): void {
  if (!RUNNER_NAME_REGEX.test(name)) {
    throw new Error(`Runner name '${name}' contains invalid chars. Allowed: letters, numbers, _ . -`);
  }
  if (name.length < 2 || name.length > 255) {
    throw new Error(`Runner name '${name}' must be 2–255 chars (got ${name.length}).`);
  }
}

async function createRunner(
  api: ApiClientOpts,
  input: { regionId: string; name: string },
): Promise<{ id: string; apiKey: string }> {
  const r = await apiFetch<CreateRunnerResponseDto>(api, "POST", `/api/runners`, {
    name: input.name,
    regionId: input.regionId,
  });
  if (!r.apiKey) {
    throw new Error(`POST /api/runners returned no apiKey: ${JSON.stringify(r)}`);
  }
  return { id: r.id, apiKey: r.apiKey };
}

async function pollUntilReady(
  api: ApiClientOpts,
  runnerId: string,
  timeoutSec: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await apiFetch<RunnerDto>(api, "GET", `/api/runners/${runnerId}`);
      if (r.state === "ready") return true;
    } catch (e) {
      // transient API blips during EC2 boot are tolerable — keep polling
      if (!(e instanceof ApiError) || e.status >= 500) {
        // network error or 5xx: log and continue
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

// ─── EC2 launch (unchanged from previous version) ───────────────────────────

const UBUNTU_OWNER_ID = "099720109477";
const UBUNTU_NAME_PATTERN = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";

interface Ec2LaunchInput {
  region: string;
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

  // Mirror the existing default Runner in sst.config.ts:564-575 exactly:
  //   - cpuOptions: { nestedVirtualization: "enabled" }
  //       → required for libkrun/KVM inside the EC2 (c8i.2xlarge supports it
  //         but it's OFF by default; without it boxlite-runner exits status=2
  //         on first libkrun call).
  //   - associatePublicIpAddress: true
  //       → set via NetworkInterfaces (RunInstances API doesn't accept the
  //         top-level field; you put SubnetId inside the NIC instead).
  //   - BlockDeviceMappings root device size
  //   - IAM instance profile (already from existing runner via wrapper)
  //
  // CpuOptions.NestedVirtualization is not in the @aws-sdk/client-ec2 types
  // yet (as of v3.700) but is accepted by the live EC2 RunInstances API —
  // cast through `any` to send it on the wire.
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
  | "REGION_RESOLVED"
  | "RUNNER_CREATED"
  | "EC2_LAUNCHED"
  | "READY"
  | "TIMEOUT_WAITING_FOR_READY"
  | "EC2_LAUNCH_FAILED";

interface ResultFile {
  schema_version: 2;
  status: RunStatus;
  runner: {
    id: string | null;
    name: string;
    apiKey: string | null;
    regionId: string;
  };
  region: {
    id: string;
    name: string;
    organizationId: string;
    type: "custom";
    createdByThisScript: boolean;
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
    regionAt: string | null;
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
    initial: {
      runner: { name: string; regionId: string };
      region: ResolvedRegion;
      ec2InstanceType: string;
    },
  ) {
    this.state = {
      schema_version: 2,
      status: "STARTED",
      runner: { id: null, name: initial.runner.name, apiKey: null, regionId: initial.runner.regionId },
      region: {
        id: initial.region.id,
        name: initial.region.name,
        organizationId: initial.region.organizationId,
        type: "custom",
        createdByThisScript: initial.region.createdByThisScript,
      },
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
        regionAt: new Date().toISOString(),
        runnerAt: null,
        ec2At: null,
        readyAt: null,
      },
      errors: [],
      next_steps: "",
    };
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
    this.state.next_steps = `Runner is READY.\n  Verify: curl ${apiUrl}/api/runners/${this.state.runner.id} -H 'Authorization: Bearer <token>' -H 'X-Organization-Id: ${this.state.region.organizationId}'`;
  }
  setTimeout() {
    this.state.status = "TIMEOUT_WAITING_FOR_READY";
    this.state.next_steps =
      `Runner did not reach READY within timeout. Investigate:\n` +
      `  - EC2 console for instance ${this.state.ec2.instanceId}\n` +
      `  - SSM Run Command: 'sudo journalctl -u boxlite-runner -n 200'`;
  }
  setEc2Failed(error: string) {
    this.state.status = "EC2_LAUNCH_FAILED";
    this.state.errors.push(error);
    this.state.next_steps =
      `EC2 launch failed but the runner row exists (orphan). Clean up:\n` +
      `  curl -X DELETE ${process.env.BOXLITE_API_URL ?? "<api-url>"}/api/runners/${this.state.runner.id} -H 'Authorization: Bearer <token>'`;
  }
  pushError(error: string) { this.state.errors.push(error); }
  flush() { writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 }); }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

interface Args {
  orgid: string;
  apiToken: string;
  apiUrl: string;
  registryUrl: string;
  subnetId: string;
  instanceProfileName: string;
  regionId?: string;
  regionName?: string;
  name?: string;
  instanceType: string;
  rootDiskGB: number;
  resultFile: string;
  timeout: number;
  noWait: boolean;
  dryRun: boolean;
  yes: boolean;
  awsProfile?: string;
}

function parseArgs(): Args {
  const p = new Command();
  p.name("add-runner")
    .description("Add one org-dedicated runner via REST + EC2 RunInstances")
    .requiredOption("--orgid <uuid>", "Organization id (required)")
    .option("--api-token <token>", "Bearer token (or env BOXLITE_API_TOKEN)")
    .option("--api-url <url>", "API base URL (or env BOXLITE_API_URL)")
    .option("--registry-url <url>", "Snapshot registry URL (or env BOXLITE_REGISTRY_URL)")
    .option("--subnet-id <id>", "VPC public subnet id for the new EC2")
    .option("--instance-profile-name <name>", "EC2 IAM instance profile name")
    .option("--region-id <id>", "Existing region id (default: 'us'). Set to empty string to fall back to find-or-create by --region-name.", "us")
    .option("--region-name <name>", "CUSTOM region name to find-or-create when --region-id is empty (default: us)")
    .option("--name <name>", "Runner name (default: runner-<random6>)")
    .option("--instance-type <type>", "EC2 instance type", "c8i.2xlarge")
    .option("--root-disk-gb <n>", "EC2 root disk size", (v) => parseInt(v, 10), 100)
    .option("--result-file <path>", "Output JSON", "./add-runner-result.json")
    .option("--timeout <seconds>", "Wait timeout in Stage 7", (v) => parseInt(v, 10), 300)
    .option("--no-wait", "Skip Stage 7 (don't wait for READY)")
    .option("--dry-run", "Print planned actions, no side effects")
    .option("--yes", "Skip interactive confirmation")
    .option("--aws-profile <name>", "AWS profile (overrides AWS_PROFILE)")
    .parse();

  const opts = p.opts();
  const apiToken = opts.apiToken ?? process.env.BOXLITE_API_TOKEN;
  const apiUrl = opts.apiUrl ?? process.env.BOXLITE_API_URL;
  const registryUrl = opts.registryUrl ?? process.env.BOXLITE_REGISTRY_URL;

  if (!apiToken || !apiUrl || !registryUrl || !opts.subnetId || !opts.instanceProfileName) {
    process.stderr.write("ERROR: missing required values. Need (via flag OR env):\n");
    if (!apiToken) process.stderr.write("  --api-token / BOXLITE_API_TOKEN\n");
    if (!apiUrl) process.stderr.write("  --api-url / BOXLITE_API_URL\n");
    if (!registryUrl) process.stderr.write("  --registry-url / BOXLITE_REGISTRY_URL\n");
    if (!opts.subnetId) process.stderr.write("  --subnet-id\n");
    if (!opts.instanceProfileName) process.stderr.write("  --instance-profile-name\n");
    process.exit(EXIT.ARGS);
  }

  return {
    orgid: opts.orgid,
    apiToken,
    apiUrl,
    registryUrl,
    subnetId: opts.subnetId,
    instanceProfileName: opts.instanceProfileName,
    regionId: opts.regionId,
    regionName: opts.regionName,
    name: opts.name,
    instanceType: opts.instanceType,
    rootDiskGB: opts.rootDiskGb,
    resultFile: path.resolve(opts.resultFile),
    timeout: opts.timeout,
    noWait: opts.wait === false,
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
    awsProfile: opts.awsProfile,
  };
}

function defaultName(): string {
  return `runner-${Math.random().toString(36).slice(2, 8)}`;
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

  const api: ApiClientOpts = { baseUrl: args.apiUrl, token: args.apiToken, orgId: args.orgid };

  if (!args.yes) {
    const proceed = await confirmTty(
      `About to create runner '${runnerName}' (${args.instanceType}) for org=${args.orgid}\n` +
        `  Stack:        ${process.env.BOXLITE_STAGE}\n` +
        `  API:          ${args.apiUrl}\n` +
        `  AWS region:   ${AWS_REGION}\n` +
        `  Subnet:       ${args.subnetId}\n` +
        `  Profile:      ${args.instanceProfileName}\n` +
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

  let region: ResolvedRegion | null = null;
  let result: ResultWriter | null = null;
  let runnerId: string | null = null;
  let apiKey: string | null = null;

  try {
    // ─── Stage 1: resolve region (find-or-create CUSTOM) ───────────────
    process.stderr.write(`[1/7] Resolving region…\n`);
    region = await resolveRegion(api, {
      orgId: args.orgid,
      regionId: args.regionId,
      regionName: args.regionName,
    });
    process.stderr.write(
      `       → region '${region.name}' (id=${region.id}${region.createdByThisScript ? ", CREATED" : ""})\n`,
    );

    // ─── Stage 2: create runner via REST ───────────────────────────────
    process.stderr.write(`[2/7] POST /api/runners…\n`);
    result = new ResultWriter(args.resultFile, {
      runner: { name: runnerName, regionId: region.id },
      region,
      ec2InstanceType: args.instanceType,
    });
    result.flush();

    const r = await createRunner(api, { regionId: region.id, name: runnerName });
    runnerId = r.id;
    apiKey = r.apiKey;
    result.setRunnerCreated(r.id, r.apiKey);
    result.flush();
    process.stderr.write(`       → runner id=${r.id}  apiKey=${redactApiKey(r.apiKey)}\n`);

    // ─── Stage 3: build user-data ──────────────────────────────────────
    process.stderr.write(`[3/7] Building EC2 user-data…\n`);
    const { buildRunnerUserData } = await import("../lib/runner-user-data");
    const userDataBase64 = buildRunnerUserData({
      apiUrl: args.apiUrl,
      token: apiKey,
      registryUrl: args.registryUrl,
      runnerPort: 3003,
      awsRegion: AWS_REGION,
      cargoTomlPath: CARGO_TOML,
    });

    // ─── Stage 4: launch EC2 ───────────────────────────────────────────
    process.stderr.write(`[4/7] Launching EC2…\n`);
    const ec2Client = new EC2Client({ region: AWS_REGION });
    let ec2Result: Ec2LaunchResult;
    try {
      ec2Result = await launchRunnerEc2(ec2Client, {
        region: AWS_REGION,
        subnetId: args.subnetId,
        instanceProfileName: args.instanceProfileName,
        instanceType: args.instanceType,
        rootDiskGB: args.rootDiskGB,
        userDataBase64,
        tags: {
          Name: `boxlite-runner-${runnerId.slice(0, 8)}`,
          RunnerId: runnerId,
          BoxliteOwner: "add-runner-script",
          BoxliteStack: process.env.BOXLITE_STAGE!,
        },
      });
    } catch (e: any) {
      result.setEc2Failed(e.message ?? String(e));
      result.flush();
      throw e;
    }

    // ─── Stage 5: update result file ───────────────────────────────────
    process.stderr.write(`       → instance ${ec2Result.instanceId}, ip=${ec2Result.publicIp ?? "<pending>"}\n`);
    result.setEc2Launched({
      instanceId: ec2Result.instanceId,
      publicIp: ec2Result.publicIp,
      privateIp: ec2Result.privateIp,
      availabilityZone: ec2Result.availabilityZone,
    });
    result.flush();
    process.stderr.write(`[5/7] Result file updated.\n`);

    // ─── Stage 6: maybe wait ───────────────────────────────────────────
    if (args.noWait) {
      process.stderr.write(`[6/7] --no-wait: skipping readiness poll.\n[7/7] Exiting OK.\n`);
      return EXIT.OK;
    }
    process.stderr.write(`[6/7] Polling GET /api/runners/${runnerId} for state=ready (timeout ${args.timeout}s)…\n`);

    // ─── Stage 7: poll for READY ───────────────────────────────────────
    const ready = await pollUntilReady(api, runnerId, args.timeout);
    if (ready) {
      result.setReady(args.apiUrl);
      result.flush();
      process.stderr.write(`[7/7] → READY. Result file: ${args.resultFile}\n`);
      return EXIT.OK;
    } else {
      result.setTimeout();
      result.flush();
      process.stderr.write(
        `[7/7] → TIMEOUT waiting for READY. EC2 + runner row exist; investigate.\n` +
          `       Result file: ${args.resultFile}\n`,
      );
      return EXIT.TIMEOUT;
    }
  } catch (e: any) {
    if (e instanceof ApiError) {
      process.stderr.write(`ERROR (REST): ${e.message}\n`);
      if (e.status === 403 && /ORGANIZATION_INFRASTRUCTURE|FORBIDDEN/i.test(e.body)) {
        process.stderr.write(
          `       Hint: enable the ORGANIZATION_INFRASTRUCTURE feature flag for org ${args.orgid}.\n`,
        );
      }
      if (e.status === 401) {
        process.stderr.write(`       Hint: invalid or expired BOXLITE_API_TOKEN.\n`);
      }
      return EXIT.API;
    }
    if (e.message?.includes("RunInstances") || e.message?.includes("AMI")) {
      process.stderr.write(`ERROR (Stage 4 EC2): ${e.message}\n`);
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
