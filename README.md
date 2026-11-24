# orders-api

[![ci](https://github.com/Abi0066/orders-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Abi0066/orders-api/actions/workflows/ci.yml)

Small Express service used as the workload of a progressive-delivery demo
(Kind + Argo Rollouts + Prometheus + ingress-nginx). The application itself is
deliberately boring; what matters is that it exposes **honest metrics** and a
**deterministic failure switch**, so a canary analysis can tell a good release
from a bad one.

## Endpoints

| Path | Purpose | Notes |
|---|---|---|
| `GET /health` | liveness summary | `{status, version, env, fail_mode, fail_rate}` |
| `GET /ready` | readiness probe | 200 as soon as the server listens |
| `GET /live` | liveness probe | 200, never depends on upstreams |
| `GET /api/orders` | the business endpoint | 500 when degrading (see `FAIL_RATE`) |
| `GET /api/orders/:id` | single order | 404 when unknown |
| `GET /metrics` | Prometheus exposition | `prom-client`, registry per process |

Every response carries `X-App-Version: <APP_VERSION>`, which is how the demo proves
which version actually served a request (`v2` after a rollback, `v3` during a canary).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `APP_VERSION` | `v1` | reported by `/health` and `X-App-Version` |
| `APP_ENV` | `demo` | free-form label |
| `FAIL_RATE` | `0` | percentage (0–100) of `/api/orders` requests that return 500 |
| `FAIL_MODE` | – | shorthand: `true` means `FAIL_RATE=100` |

`FAIL_RATE` is what makes the demo interesting: a canary degrading 40 % of its
traffic is a much better test of an analysis threshold than a service that is
either up or down.

## Metrics

```
http_requests_total{method,route,status}          counter
http_request_duration_seconds{method,route,status} histogram
nodejs_*                                          default process metrics
```

`route` is the **matched Express route pattern** (`/api/orders`, `/api/orders/:id`,
`/ready`…), not the raw path, so label cardinality stays bounded. This is also what
lets the canary AnalysisTemplate exclude kubelet probes and Prometheus scrapes from
the success-rate query.

## Run locally

```bash
npm ci
npm test                       # node:test, 7 tests, no external dependency
npm start                      # or: APP_VERSION=v2 FAIL_RATE=100 npm start
./scripts/smoke.sh             # starts the server, curls every endpoint, stops it
```

## Container image

```bash
docker build -t ghcr.io/abi0066/orders-api:v1 .
```

Three details that matter for the Kind demo:

- the runtime stage runs as the unprivileged `node` user, so the Rollout can set
  `runAsNonRoot`, `readOnlyRootFilesystem: true` and drop **all** capabilities;
- `npm`/`npx` are removed from the runtime stage: they are build-time tools and
  their bundled dependencies (sigstore, picomatch…) were the only CRITICAL/HIGH
  findings in the Trivy scan of a service that just runs `node src/app.js`;
- the image is referenced with its full registry path (`ghcr.io/...`). A bare
  `orders-api:v1` loaded with `kind load docker-image` lands in containerd as
  `localhost/orders-api:v1` and a pod asking for `orders-api:v1` will not find it.
  Manifests also use `imagePullPolicy: IfNotPresent`, otherwise Kind tries Docker Hub.

The image is identical for `v1`, `v2` and `v3`: the release is defined by the tag
plus `APP_VERSION`/`FAIL_RATE`, so a failure can be reproduced without touching code.

## CI

`.github/workflows/ci.yml` runs the test suite, builds the image, scans it with Trivy
(fails on CRITICAL/HIGH, fixed versions only), pushes it to GHCR and signs it:

```
ghcr.io/abi0066/orders-api:sha-<commit>   (immutable)
ghcr.io/abi0066/orders-api:latest
```

The package is publicly pullable, signing is **keyless** (`id-token: write` → short-lived
Fulcio certificate, entry in the Rekor transparency log, no long-lived key to store or
leak), and buildx attaches build provenance + an SPDX SBOM as OCI attestations next to
the image.

### Verify a published image

```bash
cosign verify ghcr.io/abi0066/orders-api:sha-<commit> \
  --certificate-identity-regexp 'https://github.com/Abi0066/orders-api/.github/workflows/ci.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Expected: `The cosign claims were validated`, `Existence of the claims in the
transparency log was verified offline`, `The code-signing certificate was verified
using trusted certificate authority certificates`.

The provenance/SBOM attestations live in the image index; this works without Docker:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:abi0066/orders-api:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "https://ghcr.io/v2/abi0066/orders-api/manifests/sha-<commit>" \
  | jq -r '.manifests[] | "\(.platform.architecture) \(.annotations["vnd.docker.reference.type"] // "-")"'
# amd64  -
# unknown  attestation-manifest
```

On a machine with Docker, `docker buildx imagetools inspect --format '{{json .SBOM}}'
ghcr.io/abi0066/orders-api:sha-<commit>` prints the SBOM itself.

The workflow does not deploy: pinning the new tag in the demo cluster is a commit in
the companion `orders-gitops` repository, which ArgoCD reconciles.

**Not in place yet:** nothing *enforces* the signature at admission. A Kyverno or
Connaisseur policy refusing unsigned images is the next step — today the signature is
verifiable, not mandatory.
