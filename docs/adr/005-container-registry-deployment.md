# ADR-005: Container Registry Deployment Model (GHCR)

## Status: Proposed

## Context

The isnad-graph platform currently deploys via a CI workflow that SSHs into the Hetzner VPS, runs `git pull`, and executes `docker compose -f docker-compose.prod.yml up -d --build --remove-orphans` on the server itself. This approach has several drawbacks:

- **Build times on VPS are slow.** The VPS has limited CPU/memory compared to GitHub Actions runners, making `--build` the bottleneck in every deploy.
- **No image versioning.** There is no way to identify which image is running beyond checking the git commit on disk. Rollback requires a `git revert` + full rebuild.
- **No separation of build and deploy.** A build failure during deploy leaves the VPS in a partially-updated state. Build concerns (compilers, build tools) are conflated with runtime concerns.
- **Reproducibility.** Builds on the VPS may differ from local builds due to Docker cache state, available disk, or transient network issues when fetching base images.

We need a model where images are built once in CI, stored in a registry, and pulled by the VPS for deployment — separating the build artifact from the deploy target.

### Services requiring custom images

| Service | Dockerfile | Notes |
|---------|-----------|-------|
| `api` | `./Dockerfile` | Python 3.14-slim, uv, FastAPI |
| `frontend` | `./frontend/Dockerfile` | Node 24 build → nginx:alpine |
| `neo4j` | `./infra/neo4j/Dockerfile` | Neo4j 5-community + GDS plugin |

All other services (`postgres`, `redis`, `caddy`, `prometheus`, `grafana`, `loki`, `promtail`, `node-exporter`, `alertmanager`, `postgres-exporter`) use upstream images directly and are unaffected by this change.

## Decision

Build custom Docker images in GitHub Actions CI, push them to GitHub Container Registry (GHCR), and update the deploy workflow to pull pre-built images instead of building on the VPS.

### 1. Image build strategy

**Multi-stage builds** are already used for the frontend. The API Dockerfile should be extended to a proper multi-stage build to separate dependency installation from the runtime layer:

```dockerfile
# Stage 1: build dependencies
FROM python:3.14-slim AS builder
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev

# Stage 2: runtime
FROM python:3.14-slim
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY src/ src/
ENV PATH="/app/.venv/bin:$PATH"
CMD ["uvicorn", "src.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
```

**Layer caching in CI** uses `actions/cache` with Docker buildx:

```yaml
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

GitHub Actions cache (10 GB per repo) is sufficient for our three images.

**`.dockerignore` audit.** The current `.dockerignore` already excludes `.git`, `data/`, `__pycache__`, caches, and `node_modules`. Add `docs/`, `tests/`, `.github/`, `.claude/`, `infra/` (for the API build context), and `*.md` to further reduce context size.

### 2. Image size budget

| Image | Current estimate | Target | Strategy |
|-------|-----------------|--------|----------|
| `api` | ~350 MB | < 250 MB | Multi-stage build, exclude dev deps, slim base |
| `frontend` | ~25 MB | < 30 MB | Already multi-stage (node build → nginx:alpine) |
| `neo4j` | ~650 MB | < 700 MB | Base neo4j image is large; GDS JAR adds ~80 MB. No optimization possible without dropping GDS. |

Measure with `docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}'` after each CI build. Add a CI step that fails if any custom image exceeds its budget by more than 20%.

### 3. Tagging strategy

Each image is tagged with three tags on every push to `main`:

| Tag | Example | Mutable? | Purpose |
|-----|---------|----------|---------|
| Full SHA | `ghcr.io/parametrization/isnad-graph-api:<full-commit-sha>` | **Immutable** | Precise identification, rollback target |
| Short SHA | `ghcr.io/parametrization/isnad-graph-api:<short-sha>` | **Immutable** | Human-readable convenience |
| `latest` | `ghcr.io/parametrization/isnad-graph-api:latest` | Mutable | Always points to most recent main build |

**Tag naming convention:** `ghcr.io/parametrization/isnad-graph-{service}:{tag}`

Three image repositories in GHCR:
- `ghcr.io/parametrization/isnad-graph-api`
- `ghcr.io/parametrization/isnad-graph-frontend`
- `ghcr.io/parametrization/isnad-graph-neo4j`

### 4. Tag immutability policy

- **SHA tags are immutable.** Once a SHA-tagged image is pushed, it must never be overwritten. The CI workflow enforces this by using `docker/build-push-action` which creates unique manifests per SHA.
- **`latest` is the only mutable tag.** It always points to the most recent successful build from `main`.
- **No semver tags at this time.** The project does not have a formal release cadence that warrants semantic versioning on images. Phase-wave GitHub releases serve this purpose. If needed later, semver tags (e.g., `v1.2.3`) can be added as additional immutable tags on release events.
- **Enforcement:** The CI build step tags images using `${{ github.sha }}` and `latest`. There is no mechanism to re-push a SHA tag without a new commit, which naturally enforces immutability.

### 5. GHCR garbage collection and retention policy

GHCR does not have built-in garbage collection. Untagged manifests and old images accumulate unless explicitly deleted.

**Retention policy:**

| Category | Retention | Mechanism |
|----------|-----------|-----------|
| Tagged images (SHA) | Keep last 50 per repository | GitHub Actions scheduled job (weekly) |
| `latest` tag | Always kept | N/A |
| Untagged manifests | Delete after 7 days | Same scheduled job |

**Implementation:** A scheduled GitHub Actions workflow runs weekly using the `ghcr.io` API (via `gh api`) to:
1. List all image versions for each repository.
2. Delete untagged versions older than 7 days.
3. Keep the 50 most recent SHA-tagged versions; delete older ones.

**Storage impact estimate:** Each build produces ~1 GB across all three images (250 MB API + 30 MB frontend + 700 MB neo4j). With 50 retained versions, steady-state storage is ~50 GB. GitHub Free plan includes unlimited public package storage; private repos have 500 MB free with additional storage at $0.008/GB/day. If the repository is public, this is free.

### 6. Secret management

#### CI (GitHub Actions → GHCR)

- Use `GITHUB_TOKEN` (automatically available in Actions) to authenticate with GHCR. This requires the repository's package settings to grant Actions write access. No PAT needed for CI.
- Login step: `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`.

#### VPS (pull from GHCR)

- **A `GITHUB_TOKEN` does not work outside GitHub Actions.** The VPS needs a separate credential.
- Create a **fine-grained Personal Access Token (PAT)** scoped to `read:packages` only, belonging to a machine user or the repository owner.
- **Provisioning:** Store the PAT as a GitHub Actions secret (`GHCR_PULL_TOKEN`). The deploy workflow passes it to the VPS via the SSH action's `envs` parameter and runs `echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u parametrization --password-stdin` before `docker compose pull`.
- **Rotation:** Fine-grained PATs support expiration. Set a 90-day expiry. Add a scheduled CI job that checks token expiry and opens an issue 14 days before expiration as a reminder to rotate.
- **No secrets in files:** The PAT is never written to `.env`, `docker-compose.prod.yml`, or any file on disk. It is used in a single `docker login` command within the deploy script and stored only in Docker's credential store (`~/.docker/config.json` on the VPS, which is `0600` by default).

#### Existing secrets (unchanged)

`NEO4J_PASSWORD`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`, and `DEPLOY_SSH_PRIVATE_KEY` continue to be managed as GitHub Actions secrets, passed to the VPS via the SSH action's `envs` parameter.

### 7. Compose file split strategy

**Approach: Override files.** Use Docker Compose's built-in file merging rather than maintaining two separate files.

| File | Purpose | Contains |
|------|---------|----------|
| `docker-compose.yml` | Base configuration | Service definitions, networks, volumes, env vars, health checks, resource limits, logging — everything shared between dev and prod |
| `docker-compose.override.yml` | Development overrides (auto-loaded) | `build:` directives for all custom images, port bindings for debugging, volume mounts for live-reload |
| `docker-compose.prod.yml` | Production overrides | `image:` directives pointing to GHCR, production-only services (caddy, observability stack), read-only filesystem, production resource limits |

**Usage:**

```bash
# Development (auto-loads override)
docker compose up -d --build

# Production (explicit file selection)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Key changes to `docker-compose.prod.yml`:**

```yaml
services:
  api:
    image: ghcr.io/parametrization/isnad-graph-api:${IMAGE_TAG:-latest}
    # build: directive removed — image is pre-built

  frontend:
    image: ghcr.io/parametrization/isnad-graph-frontend:${IMAGE_TAG:-latest}
    # build: directive removed

  neo4j:
    image: ghcr.io/parametrization/isnad-graph-neo4j:${IMAGE_TAG:-latest}
    # build: directive removed
```

The `IMAGE_TAG` environment variable defaults to `latest` but can be overridden for rollback (see § Rollback procedure).

### 8. CI build workflow

A new workflow, `.github/workflows/build-images.yml`, triggers on push to `main`:

```yaml
name: Build & Push Images
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        include:
          - service: api
            context: .
            dockerfile: Dockerfile
          - service: frontend
            context: ./frontend
            dockerfile: Dockerfile
          - service: neo4j
            context: ./infra/neo4j
            dockerfile: Dockerfile
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.context }}/${{ matrix.dockerfile }}
          push: true
          tags: |
            ghcr.io/parametrization/isnad-graph-${{ matrix.service }}:${{ github.sha }}
            ghcr.io/parametrization/isnad-graph-${{ matrix.service }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

The existing `deploy.yml` workflow is updated to depend on the build job (via `workflow_run` or by combining into a single workflow) and changes its deploy script from:

```bash
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
```

to:

```bash
echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u parametrization --password-stdin
export IMAGE_TAG="${GITHUB_SHA}"
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull api frontend neo4j
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
```

### 9. Health check integration with deploy

The current deploy workflow already performs health checks via `docker inspect --format='{{.State.Health.Status}}'`. This approach continues to work because all custom images define `HEALTHCHECK` instructions (either in the Dockerfile or in the compose file's `healthcheck:` directive).

**Deploy health check sequence:**

1. `docker compose pull` — fetch new images.
2. `docker compose up -d --remove-orphans` — recreate containers with new images.
3. Wait for Docker's built-in health checks to pass using `docker compose up --wait` (available in Compose v2.20+). This blocks until all services with health checks report healthy, or times out.
4. If `--wait` times out (default 120s, configurable with `--wait-timeout`), the deploy step fails and triggers the rollback procedure.

**Fallback:** If the VPS Docker Compose version does not support `--wait`, retain the current polling loop (`docker inspect` in a loop with 24 × 5s attempts).

The existing per-service `healthcheck:` directives in `docker-compose.prod.yml` are authoritative. No separate curl-based health check is needed in the deploy script — Docker handles it.

### 10. Rollback procedure

Rollback replaces the current images with a known-good previous version.

#### Identifying the previous good version

```bash
# On the VPS, check which image is currently running:
docker inspect --format='{{.Config.Image}}' isnad-graph-api-1
# → ghcr.io/parametrization/isnad-graph-api:<full-commit-sha>

# In GHCR, list recent tags:
gh api /user/packages/container/isnad-graph-api/versions \
  --jq '.[0:10] | .[] | {id: .id, tags: .metadata.container.tags, created: .created_at}'
```

#### Manual rollback steps

```bash
# 1. SSH into VPS
ssh deploy@<VPS_HOST>
cd /opt/isnad-graph

# 2. Set the rollback target (SHA of last known-good deploy)
export IMAGE_TAG="<previous-good-sha>"

# 3. Pull the previous images
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull api frontend neo4j

# 4. Restart with previous images
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans

# 5. Verify health
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --format '{{.Name}}\t{{.Status}}'
```

#### Automated rollback (future enhancement)

The deploy workflow can be extended with an automatic rollback step:

```yaml
- name: Rollback on failure
  if: failure()
  uses: appleboy/ssh-action@v1
  with:
    script: |
      cd /opt/isnad-graph
      export IMAGE_TAG="$(cat /opt/isnad-graph/.last-good-sha)"
      docker compose -f docker-compose.yml -f docker-compose.prod.yml pull api frontend neo4j
      docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
```

The deploy script writes the current SHA to `/opt/isnad-graph/.last-good-sha` after a successful health check, so the rollback target is always the previous successful deploy.

#### Rollback scope

- Rolling back **all three custom images** together is the default. Services share a commit SHA, so they should be deployed and rolled back as a unit.
- Rolling back **a single service** is possible by setting `IMAGE_TAG` only for that service (via per-service environment variables in the compose file), but this is not recommended as it may introduce version skew.

### 11. Migration path

The migration is incremental — one service at a time — to reduce risk.

**Phase A: CI build pipeline (no deploy changes)**
1. Add the `build-images.yml` workflow.
2. Verify images build and push to GHCR on merge to `main`.
3. Verify image sizes are within budget.
4. No changes to deploy workflow — VPS continues to build locally.

**Phase B: Frontend (lowest risk)**
1. Update `docker-compose.prod.yml` to use `image:` for frontend.
2. Update deploy workflow to pull frontend image.
3. Deploy and verify. Frontend is stateless and easy to roll back.

**Phase C: API**
1. Update `docker-compose.prod.yml` to use `image:` for API.
2. Update deploy workflow to pull API image.
3. Deploy and verify. API health check confirms correct operation.

**Phase D: Neo4j**
1. Update `docker-compose.prod.yml` to use `image:` for neo4j.
2. Update deploy workflow to pull neo4j image.
3. Deploy and verify. Neo4j data is in a named volume, unaffected by image swap.

**Phase E: Cleanup**
1. Remove `--build` from deploy workflow.
2. Split compose files (base + override + prod) per § Compose file split strategy.
3. Add image size budget CI check.
4. Add GHCR retention/cleanup scheduled job.
5. Set up PAT rotation reminder job.

### 12. Security considerations

- **Image scanning:** Add `anchore/scan-action` or `aquasecurity/trivy-action` to the build workflow. Scan each image after build, before push. Fail the build on critical/high CVEs.
- **GHCR access controls:** The repository's package visibility matches the repo visibility (public repo → public packages). If the repo is private, images are private by default. The `read:packages` PAT on the VPS is the only external credential.
- **Supply chain:** Pin all GitHub Actions to SHA (e.g., `docker/build-push-action@abc123`) rather than version tags to prevent supply chain attacks via tag mutation. Pin base images in Dockerfiles to digest where practical (e.g., `python:3.14-slim@sha256:...`).
- **No secrets in images:** The Dockerfiles do not embed secrets. Runtime secrets are injected via environment variables in the compose file.
- **SBOM generation:** Consider adding `docker/build-push-action`'s `sbom: true` flag to generate Software Bill of Materials for each image. Not blocking for initial rollout.

### 13. Cost and resource impact

| Category | Current | After GHCR | Impact |
|----------|---------|-----------|--------|
| CI minutes (build) | ~0 min (builds on VPS) | ~5 min per deploy (3 images × matrix) | +5 min CI; GitHub Actions Free includes 2,000 min/month |
| VPS build time | ~3–5 min per deploy | 0 (pull only, ~30s) | **4+ min saved per deploy** |
| VPS CPU during deploy | High (compilation, build) | Minimal (pull + restart) | Significant reduction in deploy-time resource pressure |
| GHCR storage | 0 | ~50 GB steady state (50 versions) | Free for public repos; ~$12/month for private |
| Network (VPS pull) | Git fetch + build deps | ~1 GB image pull per deploy | Similar bandwidth; faster due to layer caching |

## Consequences

### Positive
- Deploy times reduced from 3–5 minutes to ~30 seconds (pull + restart).
- Exact image versioning enables reliable, fast rollback.
- Build reproducibility — same image in CI and production.
- VPS resources freed from build workload during deploys.
- Image scanning in CI catches vulnerabilities before production.

### Negative
- Adds CI build step (~5 min) to the merge-to-main pipeline.
- Requires managing a GHCR pull PAT on the VPS (rotation, expiry monitoring).
- GHCR storage costs if the repository is private (~$12/month at steady state).
- Compose file split adds configuration complexity (three files instead of one).

### Neutral
- Upstream images (postgres, redis, caddy, prometheus, etc.) are unaffected — they are already pulled from public registries.
- Neo4j custom image build is dominated by the GDS plugin download, which moves from VPS-time to CI-time.

## References

- Current deploy workflow: `.github/workflows/deploy.yml`
- Current production compose: `docker-compose.prod.yml`
- Dockerfiles: `./Dockerfile`, `./frontend/Dockerfile`, `./infra/neo4j/Dockerfile`
- GHCR documentation: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- Docker build-push-action: https://github.com/docker/build-push-action
