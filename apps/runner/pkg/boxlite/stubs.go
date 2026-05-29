// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Resize changes the CPU/memory/disk allocation of a sandbox.
// BoxLite VMs don't support hot-resize, so this stops, removes, and recreates.
func (c *Client) Resize(ctx context.Context, sandboxId string, resizeDto dto.ResizeSandboxDTO) error {
	c.logger.Info("resize sandbox (stop/recreate)", "sandbox", sandboxId)

	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return fmt.Errorf("failed to get box for resize: %w", err)
	}

	info, err := bx.Info(ctx)
	if err != nil {
		return fmt.Errorf("failed to get box info for resize: %w", err)
	}

	if err := bx.Stop(ctx); err != nil {
		c.logger.Warn("failed to stop box during resize", "error", err)
	}

	if err := c.Destroy(ctx, sandboxId); err != nil {
		return fmt.Errorf("failed to destroy box during resize: %w", err)
	}

	// API sends cores / GB / GB as small integers (see apps/api ResizeSandboxDto).
	cpus := info.CPUs
	if resizeDto.Cpu > 0 {
		cpus = int(resizeDto.Cpu)
	}
	memoryMiB := info.MemoryMiB
	if resizeDto.Memory > 0 {
		memoryMiB = int(resizeDto.Memory * 1024)
	}

	opts := []boxlite.BoxOption{
		boxlite.WithName(sandboxId),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
		boxlite.WithNetwork(boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled}),
	}

	if resizeDto.Disk > 0 {
		opts = append(opts, boxlite.WithDiskSize(int(resizeDto.Disk)))
	}

	newBox, err := c.runtime.Create(ctx, info.Image, opts...)
	if err != nil {
		return fmt.Errorf("failed to recreate box during resize: %w", err)
	}

	c.mu.Lock()
	c.boxes[sandboxId] = newBox
	c.mu.Unlock()

	if err := newBox.Start(ctx); err != nil {
		return fmt.Errorf("failed to start resized box: %w", err)
	}

	return nil
}

// RecoverSandbox destroys and recreates a sandbox from its snapshot.
func (c *Client) RecoverSandbox(ctx context.Context, sandboxId string, recoverDto dto.RecoverSandboxDTO) error {
	c.logger.Info("recover sandbox", "sandbox", sandboxId)

	if err := c.Destroy(ctx, sandboxId); err != nil {
		c.logger.Warn("failed to destroy during recover", "error", err)
	}

	snapshot := "alpine:latest"
	if recoverDto.Snapshot != nil {
		snapshot = *recoverDto.Snapshot
	}

	createDto := dto.CreateSandboxDTO{
		Id:               sandboxId,
		Snapshot:         snapshot,
		OsUser:           recoverDto.OsUser,
		CpuQuota:         recoverDto.CpuQuota,
		MemoryQuota:      recoverDto.MemoryQuota,
		StorageQuota:     recoverDto.StorageQuota,
		Env:              recoverDto.Env,
		Volumes:          recoverDto.Volumes,
		NetworkBlockAll:  recoverDto.NetworkBlockAll,
		NetworkAllowList: recoverDto.NetworkAllowList,
		FromVolumeId:     recoverDto.FromVolumeId,
		UserId:           recoverDto.UserId,
	}

	_, _, err := c.Create(ctx, createDto)
	return err
}

// CreateBackup exports a sandbox to a .boxlite archive and uploads it to S3.
//
// Implementation: in-process Export via the Go SDK's new Box.Export binding
// (which calls libboxlite.a's boxlite_box_export). Replaces the original
// sidecar-HTTP approach — see docs/runner-scaling/runner-scale-design.md §10
// for why the sidecar can't coexist with the runner's runtime (BoxliteRuntime
// holds an exclusive lock on BOXLITE_HOME).
//
// **Side-effect-free w.r.t. box state**: this function does NOT stop or pause
// the box from the caller's perspective. The Rust-side `LiteBox::export`
// internally uses `with_quiesce_async` (brief VM pause during disk flatten,
// resumed automatically), so a running box stays running and a stopped box
// stays stopped. The caller decides the box lifecycle:
//   - apps/api ad-hoc-backup-check cron (5-min periodic backup): box continues
//     running normally after backup completes — no user-visible interruption.
//   - scale-down-runner.ts: explicit POST /sandbox/:id/stop BEFORE the
//     POST /sandbox/:id/backup, because the scale-down stage chain
//     (stop → backup → archive) needs the box stopped for the subsequent
//     archive stage anyway.
//
// Triggered by apps/api when an operator runs a scale-down OR when the
// ad-hoc cron fires. The matching restore path is in Client.Create →
// createFromBackupArchive.
func (c *Client) CreateBackup(ctx context.Context, sandboxId string, backupDto dto.CreateBackupDTO) error {
	bucket := os.Getenv("BOXLITE_BACKUPS_BUCKET")
	if bucket == "" {
		return fmt.Errorf("BOXLITE_BACKUPS_BUCKET env var not set; backup unavailable on this runner")
	}

	c.logger.InfoContext(ctx, "create backup via in-process export", "sandbox", sandboxId, "bucket", bucket)

	bx, err := c.getOrFetchBox(ctx, sandboxId)
	if err != nil {
		return fmt.Errorf("backup: get box: %w", err)
	}

	// Export to a temp file (the Rust archive writer needs a file, not a stream).
	// /var/lib/boxlite/tmp is a tmpfs-compatible scratch area shared with the runtime.
	tmpDir := filepath.Join(c.homeDir(), "tmp", "backup-export")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return fmt.Errorf("backup: mkdir tmp: %w", err)
	}
	archivePath := filepath.Join(tmpDir, sandboxId+".boxlite")
	defer os.Remove(archivePath)

	if err := bx.Export(ctx, archivePath); err != nil {
		return fmt.Errorf("backup: export box: %w", err)
	}

	f, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("backup: open archive: %w", err)
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return fmt.Errorf("backup: stat archive: %w", err)
	}

	s3Client, err := c.backupS3Client()
	if err != nil {
		return fmt.Errorf("backup: build s3 client: %w", err)
	}
	key := sandboxId + ".boxlite"
	if _, err := s3Client.PutObject(ctx, bucket, key, f, stat.Size(), minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	}); err != nil {
		return fmt.Errorf("backup: s3 upload to s3://%s/%s: %w", bucket, key, err)
	}

	c.logger.InfoContext(ctx, "backup complete", "sandbox", sandboxId, "s3", "s3://"+bucket+"/"+key, "bytes", stat.Size())
	return nil
}

// homeDir returns the BoxLite data directory used by the runner's runtime.
// Falls back to /var/lib/boxlite which matches the systemd unit default.
func (c *Client) homeDir() string {
	if v := os.Getenv("BOXLITE_HOME_DIR"); v != "" {
		return v
	}
	return "/var/lib/boxlite"
}

// backupS3Client builds a minio-go S3 client for the backups bucket. It prefers
// the static creds on the runner Client (set from config) — and falls back to
// the EC2 instance-profile IAM provider when those are blank (the prod default).
//
// Endpoint logic mirrors pkg/storage/minio_client.go: empty endpoint means native
// AWS S3 (region resolved from BOXLITE_BACKUPS_REGION or AWS_REGION env).
func (c *Client) backupS3Client() (*minio.Client, error) {
	region := os.Getenv("BOXLITE_BACKUPS_REGION")
	if region == "" {
		region = c.awsRegion
	}
	if region == "" {
		region = os.Getenv("AWS_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}

	endpoint := os.Getenv("BOXLITE_BACKUPS_ENDPOINT")
	useSSL := true
	if endpoint != "" {
		if strings.HasPrefix(endpoint, "http://") {
			useSSL = false
		}
		endpoint = strings.TrimPrefix(endpoint, "http://")
		endpoint = strings.TrimPrefix(endpoint, "https://")
	} else {
		endpoint = fmt.Sprintf("s3.%s.amazonaws.com", region)
	}

	var creds *credentials.Credentials
	if c.awsAccessKeyId != "" && c.awsSecretAccessKey != "" {
		creds = credentials.NewStaticV4(c.awsAccessKeyId, c.awsSecretAccessKey, "")
	} else {
		creds = credentials.NewIAM("")
	}

	return minio.New(endpoint, &minio.Options{
		Creds:  creds,
		Secure: useSSL,
		Region: region,
	})
}

// isBackupRef returns true when the snapshot reference points to a `.boxlite`
// archive backup, not a regular OCI image. Two shapes are accepted:
//   - `s3://<bucket>/<key>`               — explicit S3 URL
//   - `<registry>/<project>/backup-<id>:<ts>` — apps/api `backupSnapshot` convention
//
// The `backup-` marker is anchored to the image *name* (the final path segment,
// before the tag), NOT matched anywhere in the ref. Using strings.Contains(ref,
// "/backup-") would mis-classify a normal image whose registry/project segment
// happens to start with `backup-` (e.g. `reg.io/backup-team/myimage:1`) as a
// backup archive and route it to the S3 restore path. This mirrors the parsing
// in extractSandboxIdFromBackupRef. See apps/api/src/sandbox/managers/
// backup.manager.ts where the `backup-<id>` name is minted, and
// docs/runner-scaling/runner-scale-design.md §6 for the migration data flow.
func isBackupRef(snapshot string) bool {
	if strings.HasPrefix(snapshot, "s3://") {
		return true
	}
	lastSlash := strings.LastIndexByte(snapshot, '/')
	if lastSlash < 0 {
		return false
	}
	name := snapshot[lastSlash+1:]
	if colon := strings.IndexByte(name, ':'); colon >= 0 {
		name = name[:colon]
	}
	return strings.HasPrefix(name, "backup-")
}

// createFromBackupArchive restores a sandbox from a `.boxlite` archive in S3.
//
// Path:
//  1. resolve archive location (s3://... explicit, or BOXLITE_BACKUPS_BUCKET/<id>.boxlite),
//  2. download archive to /var/lib/boxlite/tmp/,
//  3. call runtime.ImportBox(archive, name=<id>, id=<id>) — uses our new
//     in-process FFI binding (no sidecar process required),
//  4. start the imported box and register it in c.boxes.
//
// Passing `id=<sandboxDto.Id>` to ImportBox preserves the `sandbox.id == box.id`
// invariant apps/api relies on for routing. The Rust side validates the id
// via BoxID::parse (URL-safe, ≤128 chars).
func (c *Client) createFromBackupArchive(ctx context.Context, sandboxDto dto.CreateSandboxDTO) (string, string, error) {
	c.logger.InfoContext(ctx, "restore from backup archive (in-process import)", "sandbox", sandboxDto.Id, "ref", sandboxDto.Snapshot)

	bucket, key, err := c.resolveBackupLocation(sandboxDto.Id, sandboxDto.Snapshot)
	if err != nil {
		return "", "", fmt.Errorf("restore: resolve s3 location: %w", err)
	}

	s3Client, err := c.backupS3Client()
	if err != nil {
		return "", "", fmt.Errorf("restore: s3 client: %w", err)
	}

	tmpDir := filepath.Join(c.homeDir(), "tmp", "backup-import")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return "", "", fmt.Errorf("restore: mkdir tmp: %w", err)
	}
	archivePath := filepath.Join(tmpDir, sandboxDto.Id+".boxlite")
	defer os.Remove(archivePath)

	if err := s3Client.FGetObject(ctx, bucket, key, archivePath, minio.GetObjectOptions{}); err != nil {
		return "", "", fmt.Errorf("restore: s3 get s3://%s/%s: %w", bucket, key, err)
	}

	bx, err := c.runtime.ImportBox(ctx, archivePath, sandboxDto.Id, sandboxDto.Id)
	if err != nil {
		return "", "", fmt.Errorf("restore: import box: %w", err)
	}

	c.mu.Lock()
	c.boxes[sandboxDto.Id] = bx
	c.mu.Unlock()

	skipStart := sandboxDto.SkipStart != nil && *sandboxDto.SkipStart
	if !skipStart {
		if err := bx.Start(ctx); err != nil {
			return bx.ID(), "", fmt.Errorf("restore: start: %w", err)
		}
	}

	c.logger.InfoContext(ctx, "restore complete", "sandbox", sandboxDto.Id, "boxId", bx.ID())
	return bx.ID(), "boxlite", nil
}

// inspectBackupArchiveInS3 issues a HEAD-equivalent against the S3 archive for
// a sandbox referenced by the given backup ref. Used by InspectImageInRegistry
// to satisfy apps/api's pre-restore "does this exist?" check without a Docker
// registry round-trip. Returns ETag (as digest) + Content-Length.
//
// Because the archive is latest-only (see resolveBackupLocation), ANY backup
// ref of a sandbox resolves to the same single object — so this reports "exists"
// for every historical ref as long as one backup exists. apps/api's newest-first
// existence probe therefore always matches the newest ref and restores the
// latest archive; it never reaches (and cannot honor) an older ref.
func (c *Client) inspectBackupArchiveInS3(ctx context.Context, snapshotRef string) (string, int64, error) {
	sandboxId := extractSandboxIdFromBackupRef(snapshotRef)
	if sandboxId == "" {
		return "", 0, fmt.Errorf("cannot extract sandbox id from backup ref %q", snapshotRef)
	}
	bucket, key, err := c.resolveBackupLocation(sandboxId, snapshotRef)
	if err != nil {
		return "", 0, err
	}
	s3Client, err := c.backupS3Client()
	if err != nil {
		return "", 0, fmt.Errorf("s3 client: %w", err)
	}
	stat, err := s3Client.StatObject(ctx, bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("stat s3://%s/%s: %w", bucket, key, err)
	}
	// Strip surrounding quotes from ETag; ensure non-empty so apps/api doesn't
	// short-circuit with "empty digest" error.
	digest := strings.Trim(stat.ETag, "\"")
	if digest == "" {
		digest = "sha256:" + sandboxId
	}
	return digest, stat.Size, nil
}

// extractSandboxIdFromBackupRef pulls "<id>" out of either
// `s3://<bucket>/<id>.boxlite` or `<reg>/<proj>/backup-<id>:<ts>`.
func extractSandboxIdFromBackupRef(ref string) string {
	if strings.HasPrefix(ref, "s3://") {
		trimmed := strings.TrimPrefix(ref, "s3://")
		slash := strings.IndexByte(trimmed, '/')
		if slash < 0 {
			return ""
		}
		key := trimmed[slash+1:]
		return strings.TrimSuffix(key, ".boxlite")
	}
	// `<...>/backup-<id>:<tag>`
	marker := "/backup-"
	idx := strings.LastIndex(ref, marker)
	if idx < 0 {
		return ""
	}
	rest := ref[idx+len(marker):]
	if colon := strings.IndexByte(rest, ':'); colon >= 0 {
		rest = rest[:colon]
	}
	return rest
}

// resolveBackupLocation extracts the S3 (bucket,key) tuple for an archive,
// from either an `s3://` URL or by combining BOXLITE_BACKUPS_BUCKET + <id>.boxlite.
//
// LATEST-ONLY semantics (deliberate, MVP scope): the key is keyed solely by
// sandbox id (no timestamp), so each CreateBackup OVERWRITES the previous
// archive — exactly one `.boxlite` object per sandbox is retained. apps/api
// mints timestamped refs (`backup-<id>:<ts>`) and keeps a history list
// (`existingBackupSnapshots`) whose "fall back to an older backup" loop in
// sandbox-start.action.ts is therefore a NO-OP on BoxLite runners: every
// historical ref of a sandbox resolves to the same single object, so the most
// recent backup is always what gets restored. This is correct for the only
// uses today (start-after-stop and scale-down migration both want the latest)
// but means there is no point-in-time restore / corrupt-latest fallback.
// Introducing those would require a timestamped key + a retention/cleanup
// policy + aligning apps/api's ref selection — out of scope here.
func (c *Client) resolveBackupLocation(sandboxId, ref string) (string, string, error) {
	if strings.HasPrefix(ref, "s3://") {
		trimmed := strings.TrimPrefix(ref, "s3://")
		slash := strings.IndexByte(trimmed, '/')
		if slash <= 0 || slash == len(trimmed)-1 {
			return "", "", fmt.Errorf("invalid s3 ref %q", ref)
		}
		return trimmed[:slash], trimmed[slash+1:], nil
	}
	bucket := os.Getenv("BOXLITE_BACKUPS_BUCKET")
	if bucket == "" {
		return "", "", fmt.Errorf("BOXLITE_BACKUPS_BUCKET env var not set; cannot resolve backup ref %q", ref)
	}
	return bucket, sandboxId + ".boxlite", nil
}

// BuildSnapshot builds an image from a Dockerfile.
// TODO: Implement OCI builder integration.
func (c *Client) BuildSnapshot(ctx context.Context, req dto.BuildSnapshotRequestDTO) error {
	c.logger.Warn("build snapshot not yet implemented in BoxLite", "snapshot", req.Snapshot)
	return errdefs.ErrNotImplemented.WithMessage("snapshot build is not supported by the BoxLite Go SDK")
}

// GetImageInfo returns metadata about a cached image.
func (c *Client) GetImageInfo(ctx context.Context, imageName string) (*ImageInfo, error) {
	img, err := c.GetImageInfoFromCache(ctx, imageName)
	if err != nil {
		return nil, err
	}
	var sizeGB float64
	if img.SizeBytes != nil {
		sizeGB = float64(*img.SizeBytes) / (1024 * 1024 * 1024)
	}
	return &ImageInfo{
		Size: int64(sizeGB * 1024 * 1024 * 1024),
		Hash: img.ID,
	}, nil
}

// UpdateNetworkSettings updates the network allowlist/blocklist for a sandbox.
// TODO: Implement when BoxLite Go SDK exposes network configuration.
func (c *Client) UpdateNetworkSettings(ctx context.Context, sandboxId string, settings dto.UpdateNetworkSettingsDTO) error {
	c.logger.Warn("update network settings not yet implemented in BoxLite", "sandbox", sandboxId)
	return errdefs.ErrNotImplemented.WithMessage("live network settings update is not supported by the BoxLite Go SDK")
}

// TagImage tags a local image with a new name.
func (c *Client) TagImage(ctx context.Context, sourceImage string, targetImage string) error {
	c.logger.Warn("tag image not yet implemented in BoxLite", "source", sourceImage, "target", targetImage)
	return errdefs.ErrNotImplemented.WithMessage("image tagging is not supported by the BoxLite Go SDK")
}

// PushImage pushes a local image to a remote registry.
func (c *Client) PushImage(ctx context.Context, imageName string, reg *dto.RegistryDTO) error {
	c.logger.Warn("push image not yet implemented in BoxLite", "image", imageName)
	return errdefs.ErrNotImplemented.WithMessage("image push is not supported by the BoxLite Go SDK")
}

// GetDaemonVersion returns the version of the in-sandbox daemon.
func (c *Client) GetDaemonVersion(ctx context.Context, sandboxId string) (string, error) {
	return "boxlite", nil
}

// ImageInfo holds metadata about an image.
type ImageInfo struct {
	Size       int64
	Entrypoint []string
	Cmd        []string
	Hash       string
}

// ImageDigest holds a registry image's digest.
type ImageDigest struct {
	Digest string
	Size   int64
}
