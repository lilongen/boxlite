"""Preflight checks — run before any runtime mutation.

Checks (walking skeleton, postgres-only):
  1. BoxLite SDK importable
  2. BoxLite runtime reachable (list_info succeeds)
  3. For each (host_port, _) in services[*].ports: lsof shows no non-boxlite listener

Each check returns a DoctorCheck. doctor() aggregates them into a DoctorReport.
If strict=True and any check is Severity.FAIL, raises DoctorError.

macOS-only: relies on `lsof` and BSD-style flags. Cross-platform support is
out of scope for the walking skeleton.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import InfraConfig
from .types import DoctorCheck, DoctorError, DoctorReport, ServiceSpec, Severity


@dataclass(frozen=True)
class _LsofRow:
    pid: int
    cmd: str
    user: str
    name: str


def _parse_lsof_F(output: str) -> list[_LsofRow]:
    """Parse `lsof -F pcLn` machine-readable output into rows.

    Format: one field per line, prefix byte indicates field type.
      p<pid>   c<command>   L<login>   n<name>
    Process records are introduced by `p`. Subsequent fields belong to
    that process until the next `p`.
    """
    rows: list[_LsofRow] = []
    pid: int | None = None
    cmd = user = name = ""
    for line in output.splitlines():
        if not line:
            continue
        prefix, value = line[0], line[1:]
        if prefix == "p":
            if pid is not None:
                rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
            pid = int(value)
            cmd = user = name = ""
        elif prefix == "c":
            cmd = value
        elif prefix == "L":
            user = value
        elif prefix == "n":
            name = value
    if pid is not None:
        rows.append(_LsofRow(pid=pid, cmd=cmd, user=user, name=name))
    return rows


def _is_boxlite_owner(cmd: str) -> bool:
    """True iff the lsof command name is one of ours (boxlite-serve, boxlited, boxlite-s truncation, ...)."""
    return cmd.startswith("boxlite")


def check_sdk_importable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite  # noqa: F401
        except ImportError:
            from boxlite.boxlite import Boxlite  # noqa: F401
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.OK,
            msg="BoxLite SDK importable",
        )
    except ImportError as e:
        return DoctorCheck(
            name="sdk-importable",
            severity=Severity.FAIL,
            msg=f"BoxLite Python SDK not importable: {e}",
            hint="Run `pip install -e sdks/python` from the boxlite repo, and confirm `which python` points at the right interpreter.",
        )


async def check_runtime_reachable() -> DoctorCheck:
    try:
        try:
            from boxlite import Boxlite
        except ImportError:
            from boxlite.boxlite import Boxlite
        runtime = Boxlite.default()
        await runtime.list_info()
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.OK,
            msg="BoxLite runtime reachable",
        )
    except Exception as e:
        return DoctorCheck(
            name="runtime-reachable",
            severity=Severity.FAIL,
            msg=f"BoxLite runtime not responding: {type(e).__name__}: {e}",
            hint="Check `boxlite serve` / lockfile state.",
        )


def check_port_free(port: int) -> DoctorCheck:
    """Pass if no listener on `port`, OR the listener's command starts with `boxlite`."""
    name = f"port-{port}-free"
    if not shutil.which("lsof"):
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg="lsof not found; cannot verify port availability",
            hint="Install lsof (it's preinstalled on macOS — check your $PATH).",
        )
    proc = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "pcLn"],
        capture_output=True,
        text=True,
        check=False,
    )
    # lsof exits 1 when nothing is listening. That's the happy path.
    # If stderr is non-empty on a non-zero exit, lsof actually errored — fail
    # the check rather than silently report "free".
    if proc.returncode != 0 and not proc.stdout.strip():
        if proc.stderr.strip():
            return DoctorCheck(
                name=name,
                severity=Severity.FAIL,
                msg=f"lsof exited {proc.returncode}: {proc.stderr.strip()[:120]}",
                hint="Check lsof permissions / availability; cannot verify port conflict otherwise.",
            )
        return DoctorCheck(
            name=name,
            severity=Severity.OK,
            msg=f"port {port} is free",
        )
    rows = _parse_lsof_F(proc.stdout)
    foreign = [r for r in rows if not _is_boxlite_owner(r.cmd)]
    if foreign:
        r = foreign[0]
        return DoctorCheck(
            name=name,
            severity=Severity.FAIL,
            msg=f"port {port} held by `{r.cmd}` (PID {r.pid}, user {r.user})",
            hint="Change the host port in InfraConfig or stop the local service.",
        )
    return DoctorCheck(
        name=name,
        severity=Severity.OK,
        msg=f"port {port} free (or held only by boxlite)",
    )


# ── Lima runner preflight ────────────────────────────────────────────────────
#
# These checks are only meaningful when the user is running the Lima runner
# path (via `make lima-up`). Gated on LIMA=1 environment variable.


def _lima_status(name: str) -> str | None:
    """Return Lima instance status (Running / Stopped / etc.), or None if absent."""
    if not shutil.which("limactl"):
        return None
    proc = subprocess.run(
        ["limactl", "list", "--json"],
        capture_output=True, text=True, check=False,
    )
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("name") == name:
            return d.get("status", "")
    return None


def check_limactl_installed() -> DoctorCheck:
    """Verify limactl is on PATH."""
    if shutil.which("limactl") is None:
        return DoctorCheck(
            name="lima-limactl-installed",
            severity=Severity.FAIL,
            msg="limactl not found",
            hint="brew install lima",
        )
    return DoctorCheck(
        name="lima-limactl-installed",
        severity=Severity.OK,
        msg="limactl present",
    )


def check_socket_vmnet() -> DoctorCheck:
    """Verify socket_vmnet is installed (required for vmnet shared networking)."""
    candidates = [
        Path("/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet"),
        Path("/usr/local/opt/socket_vmnet/bin/socket_vmnet"),
    ]
    if not any(p.exists() for p in candidates):
        return DoctorCheck(
            name="lima-socket-vmnet-installed",
            severity=Severity.FAIL,
            msg="socket_vmnet missing",
            hint="brew install socket_vmnet",
        )
    return DoctorCheck(
        name="lima-socket-vmnet-installed",
        severity=Severity.OK,
        msg="socket_vmnet present",
    )


def check_lima_sudoers() -> DoctorCheck:
    """Verify /etc/sudoers.d/lima exists and references socket_vmnet."""
    p = Path("/etc/sudoers.d/lima")
    if not p.exists():
        return DoctorCheck(
            name="lima-sudoers-configured",
            severity=Severity.FAIL,
            msg="lima sudoers not configured",
            hint="limactl sudoers | sudo tee /etc/sudoers.d/lima",
        )
    return DoctorCheck(
        name="lima-sudoers-configured",
        severity=Severity.OK,
        msg="lima sudoers present",
    )


def check_lima_vm_running(name: str) -> DoctorCheck:
    """Verify the boxlite-runner Lima VM is Running."""
    status = _lima_status(name)
    if status is None:
        return DoctorCheck(
            name="lima-vm-present",
            severity=Severity.FAIL,
            msg=f"Lima VM '{name}' does not exist",
            hint="make lima-up",
        )
    if status != "Running":
        return DoctorCheck(
            name="lima-vm-present",
            severity=Severity.FAIL,
            msg=f"Lima VM '{name}' is {status}, expected Running",
            hint="make lima-up",
        )
    return DoctorCheck(
        name="lima-vm-present",
        severity=Severity.OK,
        msg=f"Lima VM '{name}' Running",
    )


def check_lima_kvm(name: str) -> DoctorCheck:
    """Verify /dev/kvm exists inside the guest (nested virt working)."""
    proc = subprocess.run(
        ["limactl", "shell", name, "--", "test", "-c", "/dev/kvm"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return DoctorCheck(
            name="lima-kvm-exposed",
            severity=Severity.FAIL,
            msg=f"/dev/kvm missing inside {name}",
            hint="Confirm `nestedVirtualization: true` in lima/runner.yaml; M3+ silicon + macOS 15+ required.",
        )
    return DoctorCheck(
        name="lima-kvm-exposed",
        severity=Severity.OK,
        msg=f"/dev/kvm exposed in {name}",
    )


def check_lima_l1_reachability(name: str) -> DoctorCheck:
    """Verify the four L1 services are reachable from inside the Lima guest.

    Services bound to 127.0.0.1 on the host are invisible from the vmnet-shared
    guest — that's the failure mode this check catches.
    """
    # Discover host gateway IP from inside the guest
    gw_proc = subprocess.run(
        ["limactl", "shell", name, "--", "bash", "-c",
         "ip route | awk '/^default/{print $3; exit}'"],
        capture_output=True, text=True, check=False,
    )
    gw = gw_proc.stdout.strip()
    if not gw:
        return DoctorCheck(
            name="lima-l1-reachability",
            severity=Severity.FAIL,
            msg="could not discover host gateway from Lima",
            hint="Check lima0 interface inside the guest; vmnet shared may be misconfigured.",
        )

    checks = [
        ("registry", f"curl -fsS --max-time 3 http://{gw}:25000/v2/ -o /dev/null"),
        ("postgres", f"timeout 3 bash -c 'cat < /dev/tcp/{gw}/25432'"),
        ("dex",      f"curl -fsS --max-time 3 http://{gw}:25556/dex/.well-known/openid-configuration -o /dev/null"),
        ("otel",     f"timeout 3 bash -c 'cat < /dev/tcp/{gw}/24317'"),
    ]
    failures: list[str] = []
    for label, cmd in checks:
        r = subprocess.run(
            ["limactl", "shell", name, "--", "bash", "-c", cmd],
            capture_output=True, text=True, check=False,
        )
        if r.returncode != 0:
            failures.append(label)
    if failures:
        return DoctorCheck(
            name="lima-l1-reachability",
            severity=Severity.FAIL,
            msg=f"unreachable from Lima: {', '.join(failures)} (gw={gw})",
            hint="Check apps/infra-local/boxlite_local/services.py bindings (0.0.0.0 not 127.0.0.1).",
        )
    return DoctorCheck(
        name="lima-l1-reachability",
        severity=Severity.OK,
        msg=f"all L1 services reachable from Lima via {gw}",
    )


def check_lima_runner_active(name: str) -> DoctorCheck:
    """Verify boxlite-runner systemd unit is active inside the VM."""
    proc = subprocess.run(
        ["limactl", "shell", name, "--", "systemctl", "is-active", "boxlite-runner"],
        capture_output=True, text=True, check=False,
    )
    state = proc.stdout.strip()
    if state != "active":
        return DoctorCheck(
            name="lima-runner-active",
            severity=Severity.WARN,
            msg=f"boxlite-runner inside {name} is '{state}'",
            hint="make lima-tail-logs to inspect; if a fresh VM, the install-runner provision may not have run yet.",
        )
    return DoctorCheck(
        name="lima-runner-active",
        severity=Severity.OK,
        msg=f"boxlite-runner active in {name}",
    )


async def doctor(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    strict: bool = True,
) -> DoctorReport:
    """Run preflight checks. Raises DoctorError if strict and any FAIL."""
    checks: list[DoctorCheck] = []
    checks.append(check_sdk_importable())
    if checks[-1].severity != Severity.FAIL:
        checks.append(await check_runtime_reachable())
    for spec in services.values():
        for host_port, _ in spec.ports:
            checks.append(check_port_free(host_port))

    # Lima-only checks (gated). Skip silently when LIMA env not set so the
    # default doctor invocation isn't noisier for users who never touch Lima.
    if os.environ.get("LIMA") == "1":
        name = os.environ.get("LIMA_NAME", "boxlite-runner")
        checks.append(check_limactl_installed())
        if checks[-1].severity == Severity.OK:
            checks.append(check_socket_vmnet())
            checks.append(check_lima_sudoers())
            checks.append(check_lima_vm_running(name))
            if checks[-1].severity == Severity.OK:
                checks.append(check_lima_kvm(name))
                checks.append(check_lima_l1_reachability(name))
                checks.append(check_lima_runner_active(name))

    report = DoctorReport(checks=checks)
    if strict and report.any_fail():
        raise DoctorError(report)
    return report


def format_report(report: DoctorReport) -> str:
    """Pretty-print a DoctorReport for the CLI doctor subcommand."""
    marker = {Severity.OK: "✓", Severity.FAIL: "✗", Severity.WARN: "⚠"}
    lines: list[str] = []
    for c in report.checks:
        lines.append(f"  {marker[c.severity]} {c.name:<24} {c.msg}")
        if c.severity != Severity.OK and c.hint:
            lines.append(f"        → {c.hint}")
    return "\n".join(lines)
