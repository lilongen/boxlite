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
import { addSharedRunner, RUNNER_NAME_REGEX } from "../lib/add-shared-runner-lib";
import { createInfraProvider } from "../lib/infra-provider/factory";
import type { IInfraProvider, InfraProviderConfig } from "../lib/infra-provider/types";

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

// ─── Helpers (CLI-local) ────────────────────────────────────────────────────

// Match apps/api/src/common/utils/api-key.ts:generateApiKeyValue() format so
// the stored value looks indistinguishable from auto-generated runner keys.
function generateRunnerApiKeyLocal(): string {
  return `dtn_${crypto.randomBytes(32).toString("hex")}`;
}

function defaultName(): string {
  return `runner-shared-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Runner name validation (kept from lib export for CLI) ──────────────────

export function validateRunnerName(name: string): void {
  if (!RUNNER_NAME_REGEX.test(name)) {
    throw new Error(`Runner name '${name}' contains invalid chars. Allowed: letters, numbers, _ . -`);
  }
  if (name.length < 2 || name.length > 255) {
    throw new Error(`Runner name '${name}' must be 2–255 chars (got ${name.length}).`);
  }
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

// ─── provider selection ──────────────────────────────────────────────────────

// Default 'aws' keeps existing CLI behaviour (EC2). 'local' spawns a native
// boxlite-runner process — primarily for infra-local testing; the API service
// (RunnerOpsService) is the main local entry point, this is for parity.
function buildProvider(args: Args): IInfraProvider {
  const kind = (process.env.BOXLITE_RUNNER_OPS_PROVIDER ?? "aws").toLowerCase();
  let cfg: InfraProviderConfig;
  if (kind === "local") {
    const runnerBin = process.env.BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN;
    if (!runnerBin) {
      throw new Error(
        "BOXLITE_RUNNER_OPS_PROVIDER=local requires BOXLITE_RUNNER_OPS_LOCAL_RUNNER_BIN",
      );
    }
    cfg = {
      kind: "local",
      runnerBin,
      dyld: process.env.BOXLITE_RUNNER_OPS_LOCAL_DYLD,
      homeRoot: process.env.BOXLITE_RUNNER_OPS_LOCAL_HOME_ROOT ?? "~/.blr",
      portBase: parseInt(process.env.BOXLITE_RUNNER_OPS_LOCAL_PORT_BASE ?? "3100", 10),
      insecureRegistries:
        process.env.BOXLITE_RUNNER_OPS_LOCAL_INSECURE_REGISTRIES ?? "127.0.0.1:25000",
      terminateGraceSec: parseInt(
        process.env.BOXLITE_RUNNER_OPS_LOCAL_TERMINATE_GRACE_SEC ?? "15",
        10,
      ),
      apiUrl: args.apiUrl,
      backupBucket: process.env.BOXLITE_RUNNER_OPS_BACKUP_BUCKET,
      backupEndpoint: process.env.BOXLITE_RUNNER_OPS_BACKUP_ENDPOINT,
      backupRegion: process.env.BOXLITE_RUNNER_OPS_BACKUP_REGION ?? "us-east-1",
      backupAccessKey: process.env.BOXLITE_RUNNER_OPS_BACKUP_ACCESS_KEY,
      backupSecretKey: process.env.BOXLITE_RUNNER_OPS_BACKUP_SECRET_KEY,
    };
  } else {
    cfg = {
      kind: "aws",
      awsRegion: AWS_REGION,
      subnetId: args.subnetId,
      instanceProfileName: args.instanceProfileName,
      registryUrl: args.registryUrl,
      cargoTomlPath: CARGO_TOML,
    };
  }
  return createInfraProvider(cfg);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs();
  const runnerName = args.name ?? defaultName();
  const runnerApiKey = args.apiKey ?? generateRunnerApiKeyLocal();

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
  let currentApiKey: string | null = null;
  let currentRunnerId: string | null = null;

  try {
    // Initialize result file upfront
    result = new ResultWriter(args.resultFile, {
      runner: { name: runnerName, regionId: args.regionId },
      ec2InstanceType: args.instanceType,
    });
    result.flush();

    // Run generator and loop over events, manually to capture the return value
    const provider = buildProvider(args);
    const gen = addSharedRunner(
      {
        apiUrl: args.apiUrl,
        adminToken: args.adminToken,
        awsRegion: AWS_REGION,
        name: runnerName,
        apiKey: runnerApiKey,
        regionId: args.regionId,
        instanceType: args.instanceType,
        diskGb: args.rootDiskGB,
        withBackupSidecar: args.withBackupSidecar,
        backupsBucket: args.backupsBucket,
        registryUrl: args.registryUrl,
        subnetId: args.subnetId,
        instanceProfileName: args.instanceProfileName,
        timeoutSec: args.timeout,
        noWait: args.noWait,
      },
      provider,
    )

    let genNext = await gen.next()
    let finalResult
    while (!genNext.done) {
      const ev = genNext.value as any
      if (ev.type === 'stage') {
        if (ev.stage === 1) {
          result.setAuthVerified();
          result.flush();
        }
        process.stderr.write(`[${ev.stage}/${ev.total}] ${ev.label}…\n`);
      } else if (ev.type === 'log') {
        process.stderr.write(`       ${ev.line}\n`);
      } else if (ev.type === 'warning') {
        process.stderr.write(`WARNING: ${ev.line}\n`);
      } else if (ev.type === 'data') {
        if (ev.key === 'apiKey') {
          currentApiKey = ev.value as string;
          process.stderr.write(`       apiKey=${redactApiKey(currentApiKey)} (full value written to ${args.resultFile})\n`);
        } else if (ev.key === 'runnerId') {
          currentRunnerId = ev.value as string;
          if (currentApiKey && currentRunnerId) {
            result.setRunnerCreated(currentRunnerId, currentApiKey);
            result.flush();
          }
        } else if (ev.key === 'ec2InstanceId') {
          result.setEc2Launched({
            instanceId: ev.value as string,
            publicIp: null,
            privateIp: null,
            availabilityZone: null,
          });
          result.flush();
        }
      }
      genNext = await gen.next()
    }
    finalResult = genNext.value as any

    // Handle final state based on what the generator returned
    let finalExitCode: number = EXIT.OK;
    if (finalResult?.finalState === 'READY') {
      result.setReady(args.apiUrl);
      finalExitCode = EXIT.OK;
    } else if (finalResult?.finalState === 'TIMEOUT') {
      result.setTimeout();
      finalExitCode = EXIT.TIMEOUT;
    } else if (finalResult?.finalState === 'INITIALIZING') {
      // noWait case - still OK but not ready yet
      finalExitCode = EXIT.OK;
    }

    result.flush();
    process.stderr.write(`       Result file: ${args.resultFile}\n`);
    return finalExitCode;
  } catch (e: any) {
    if (e.message?.includes('aborted')) {
      return EXIT.REFUSED;
    }
    if (e instanceof Error) {
      if (e.message.includes('admin role') || e.message.includes('ADMIN')) {
        process.stderr.write(`ERROR (REST): ${e.message}\n`);
        if (e.message.includes('401')) {
          process.stderr.write(
            `       Hint: BOXLITE_ADMIN_API_KEY is missing/expired. Check the API container's startup log\n` +
              `             ("Admin user created with API key: ...") or AWS Secrets Manager 'AdminApiKey'.\n`,
          );
        }
        if (e.message.includes('403')) {
          process.stderr.write(`       Hint: token is valid but lacks ADMIN role.\n`);
        }
        if (e.message.includes('Region not found')) {
          process.stderr.write(
            `       Hint: region id '${process.argv.includes("--region-id") ? "?" : "us"}' does not exist.\n` +
              `             Confirm the API's DEFAULT_REGION_ID matches --region-id (default 'us').\n`,
          );
        }
        return EXIT.API;
      }
      if (e.message.includes('RunInstances') || e.message.includes('AMI')) {
        process.stderr.write(`ERROR (Stage 5 EC2): ${e.message}\n`);
        return EXIT.EC2_LAUNCH;
      }
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
