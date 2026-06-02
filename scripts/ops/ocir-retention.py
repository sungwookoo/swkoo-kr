#!/usr/bin/env python3
"""OCIR retention for swkoo.kr swkoo/backend + swkoo/frontend.

Deletes manifest digests in OCIR that aren't referenced by any
"keep" tag. v0 keep policy = {"latest", <currently-deployed-sha>,
<N most recent SHA tags by committer date>}.

Inputs (env):
  OCIR_HOST                   nrt.ocir.io
  OCIR_TENANCY_NAMESPACE      nrznn4yiltsz
  OCIR_USERNAME               tenancy/user@example.com
  OCIR_AUTH_TOKEN             registry auth token
  GITHUB_TOKEN                (optional) for committer date lookups; without
                              it we'll likely hit GH's 60/hr unauth limit on
                              repos with many tags
  GITHUB_REPO                 (optional) "owner/name", default sungwookoo/swkoo-kr

Positional args: one or more <repo>:<deployed-sha> pairs, e.g.
  swkoo/backend:e52481de…  swkoo/frontend:e52481de…

The deployed-sha MUST exist in the registry; if missing we abort
before any DELETE — the assumption is that a missing deployed tag
means we'd be the ones to break a running rollout.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Accept header for manifest GET/HEAD. All four are spelled out per
# spec so a registry that prefers Docker over OCI media types still
# returns a usable digest.
MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])

SHA40 = re.compile(r"^[a-f0-9]{40}$")

# ───────── HTTP helpers ─────────


def _request(method, url, headers=None, data=None, *, max_retries=5):
    """urllib wrapper with exponential backoff for 429/5xx. Returns
    (status_int, headers_dict, body_bytes). 4xx (other than 429) is
    returned as-is for the caller to interpret (404 on a missing
    manifest is normal, for example)."""
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    delay = 1.0
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, dict(resp.getheaders()), resp.read()
        except urllib.error.HTTPError as e:
            transient = e.code in (429, 502, 503, 504)
            if transient and attempt < max_retries - 1:
                ra = e.headers.get("Retry-After") if e.headers else None
                wait = float(ra) if (ra and str(ra).isdigit()) else delay
                print(f"  [retry] HTTP {e.code} on {method} {url} — sleep {wait:.1f}s",
                      file=sys.stderr)
                time.sleep(wait)
                delay *= 2
                continue
            body = e.read() if e.fp else b""
            return e.code, dict(e.headers) if e.headers else {}, body
        except urllib.error.URLError as e:
            if attempt < max_retries - 1:
                print(f"  [retry] {e} — sleep {delay:.1f}s", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return 0, {}, b""


# ───────── OCIR token flow ─────────


def get_bearer(host: str, namespace: str, username: str, token: str, scope: str) -> str:
    """OCIR Bearer-token issue. The realm URL is OCIR-specific
    (/20180419/docker/token); for clean Docker Registry parity we
    could parse it out of a 401 WWW-Authenticate challenge, but
    hard-coding is fine on OCIR (no other realm exists for this
    service)."""
    realm = f"https://{host}/20180419/docker/token"
    qs = urllib.parse.urlencode({"service": host, "scope": scope})
    creds = f"{namespace}/{username}:{token}".encode()
    auth = base64.b64encode(creds).decode()
    status, _, body = _request(
        "GET", f"{realm}?{qs}",
        headers={"Authorization": f"Basic {auth}"},
    )
    if status != 200:
        raise SystemExit(f"failed to get bearer token (scope={scope}): {status} {body[:200]!r}")
    return json.loads(body)["token"]


def list_tags(host: str, full_repo: str, bearer: str) -> list[str]:
    url = f"https://{host}/v2/{full_repo}/tags/list"
    status, _, body = _request("GET", url, headers={"Authorization": f"Bearer {bearer}"})
    if status != 200:
        raise SystemExit(f"tag list failed for {full_repo}: {status} {body[:200]!r}")
    return json.loads(body).get("tags") or []


def head_manifest(host: str, full_repo: str, ref: str, bearer: str):
    url = f"https://{host}/v2/{full_repo}/manifests/{ref}"
    status, headers, _ = _request(
        "HEAD", url,
        headers={"Authorization": f"Bearer {bearer}", "Accept": MANIFEST_ACCEPT},
    )
    if status != 200:
        return None, None
    return headers.get("Docker-Content-Digest"), headers.get("Content-Type")


def get_manifest(host: str, full_repo: str, ref: str, bearer: str):
    url = f"https://{host}/v2/{full_repo}/manifests/{ref}"
    status, headers, body = _request(
        "GET", url,
        headers={"Authorization": f"Bearer {bearer}", "Accept": MANIFEST_ACCEPT},
    )
    if status != 200:
        return None, None, None
    try:
        return headers.get("Docker-Content-Digest"), headers.get("Content-Type"), json.loads(body)
    except json.JSONDecodeError:
        return None, None, None


def delete_manifest(host: str, full_repo: str, digest: str, bearer: str):
    url = f"https://{host}/v2/{full_repo}/manifests/{digest}"
    status, _, body = _request(
        "DELETE", url,
        headers={"Authorization": f"Bearer {bearer}"},
    )
    if status not in (200, 202, 204):
        raise SystemExit(f"DELETE {full_repo}@{digest} failed: {status} {body[:200]!r}")


# ───────── GitHub commit timestamp helper ─────────


def github_commit_time(repo: str, sha: str, token: str | None) -> str | None:
    """Returns ISO committer date or None (404 → orphan tag, treated
    as oldest in the sort order). When token is None we still call,
    but hit a 60/hr rate ceiling — be mindful on large tag sets."""
    url = f"https://api.github.com/repos/{repo}/commits/{sha}"
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    status, _, body = _request("GET", url, headers=headers)
    if status != 200:
        return None
    try:
        return json.loads(body)["commit"]["committer"]["date"]
    except (json.JSONDecodeError, KeyError):
        return None


# ───────── Size estimate ─────────


def estimate_reclaim(host: str, full_repo: str, manifest: dict, bearer: str) -> int:
    """Upper-bound estimate. For a manifest list / OCI index, walks all
    platform manifests. Layer sharing across the kept set isn't
    discounted (we don't have global layer reachability) — so this is
    "what would be marked unreachable", not "what frees on disk"."""
    mt = manifest.get("mediaType", "")
    if "manifest.list" in mt or "image.index" in mt:
        total = 0
        for m in manifest.get("manifests", []) or []:
            _, _, plat = get_manifest(host, full_repo, m["digest"], bearer)
            if plat:
                total += sum(layer.get("size", 0) for layer in plat.get("layers", []) or [])
        return total
    return sum(layer.get("size", 0) for layer in manifest.get("layers", []) or [])


def humansize(n: int) -> str:
    f = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if f < 1024:
            return f"{f:.1f}{unit}"
        f /= 1024
    return f"{f:.1f}TiB"


# ───────── Per-repo driver ─────────


def process_repo(host, namespace, username, token, repo, deployed_tag,
                 keep_recent, dry_run, gh_token, gh_repo):
    full_repo = f"{namespace}/{repo}"
    print(f"\n=== {repo} ===")

    bearer = get_bearer(host, namespace, username, token,
                        f"repository:{full_repo}:pull,delete")

    tags = list_tags(host, full_repo, bearer)
    print(f"  tags in registry: {len(tags)}")

    # ─ Keep policy ─
    keep_tags: set[str] = {"latest", deployed_tag}

    sha_tags = [t for t in tags if SHA40.match(t)]
    print(f"  SHA-pattern tags: {len(sha_tags)}")

    # Order SHA tags by committer date; tags missing from GH are
    # treated as oldest (sorted last). The empty string "" sorts
    # before any ISO date, so missing tags are pushed to the tail.
    sha_with_time = []
    for t in sha_tags:
        ts = github_commit_time(gh_repo, t, gh_token) or ""
        sha_with_time.append((t, ts))
    sha_with_time.sort(key=lambda x: x[1], reverse=True)
    recent = [t for t, _ in sha_with_time[:keep_recent]]
    keep_tags.update(recent)

    # ─ Tag → digest map ─
    tag_digest: dict[str, str] = {}
    for t in tags:
        d, _ = head_manifest(host, full_repo, t, bearer)
        if d:
            tag_digest[t] = d
        else:
            print(f"  [warn] could not resolve digest for tag {t}", file=sys.stderr)

    # ─ Hard abort if the deployed tag is missing from the registry ─
    if deployed_tag not in tag_digest:
        raise SystemExit(
            f"ABORT: deployed tag {repo}:{deployed_tag} not present in registry — "
            f"refusing to delete anything (registry/cluster mismatch detected)"
        )

    keep_digests = {tag_digest[t] for t in keep_tags if t in tag_digest}
    all_digests = set(tag_digest.values())
    delete_digests = all_digests - keep_digests

    # Compute which tags will disappear (any tag whose digest is in delete_digests).
    going_away = sorted(t for t, d in tag_digest.items() if d in delete_digests)
    kept_tags = sorted(t for t, d in tag_digest.items() if d in keep_digests)

    print(f"  keep set:        latest, deployed={deployed_tag[:12]}…, +{len(recent)} recent")
    print(f"  resolved keep digests:   {len(keep_digests)}")
    print(f"  resolved delete digests: {len(delete_digests)}")
    print(f"  tags that will be removed ({len(going_away)}):")
    for t in going_away[:20]:
        print(f"    - {t[:16]}{'…' if len(t) > 16 else ''}")
    if len(going_away) > 20:
        print(f"    … (+{len(going_away) - 20} more)")

    # ─ Reclaim estimate ─
    total_size = 0
    for d in delete_digests:
        _, _, m = get_manifest(host, full_repo, d, bearer)
        if m:
            total_size += estimate_reclaim(host, full_repo, m, bearer)
    print(f"  est. reclaim:    {humansize(total_size)} (upper bound; ignores layer sharing)")

    summary = {
        "repo": repo,
        "before_tag_count": len(tags),
        "going_away": going_away,
        "kept": kept_tags,
        "delete_digests": len(delete_digests),
        "reclaim_bytes": total_size,
        "dry_run": dry_run,
    }

    if dry_run or not delete_digests:
        if dry_run:
            print("  [DRY RUN] no DELETEs issued")
        else:
            print("  [no-op] nothing to delete")
        summary["after_tag_count"] = len(tags) - len(going_away)
        return summary

    # ─ Actual DELETE ─
    print(f"  deleting {len(delete_digests)} digests…")
    for d in sorted(delete_digests):
        delete_manifest(host, full_repo, d, bearer)
        print(f"    - {d}")
    # Re-list for ground truth
    after_tags = list_tags(host, full_repo, bearer)
    print(f"  AFTER: {len(after_tags)} tags remain")
    summary["after_tag_count"] = len(after_tags)
    return summary


# ───────── main ─────────


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep-recent", type=int, default=10,
                    help="keep N most-recent SHA tags per repo (default 10)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan, don't issue DELETEs")
    ap.add_argument("repos", nargs="+", metavar="REPO:DEPLOYED_TAG",
                    help="e.g. swkoo/backend:e52481de…")
    args = ap.parse_args()

    try:
        host = os.environ["OCIR_HOST"]
        namespace = os.environ["OCIR_TENANCY_NAMESPACE"]
        username = os.environ["OCIR_USERNAME"]
        token = os.environ["OCIR_AUTH_TOKEN"]
    except KeyError as e:
        raise SystemExit(f"missing required env: {e}")

    gh_token = os.environ.get("GITHUB_TOKEN") or None
    gh_repo = os.environ.get("GITHUB_REPO") or "sungwookoo/swkoo-kr"

    print(f"OCIR retention — host={host} ns={namespace}")
    print(f"keep_recent={args.keep_recent}  dry_run={args.dry_run}")
    print(f"github commits via {'auth token' if gh_token else 'unauth (60/hr cap)'}: {gh_repo}")

    summaries = []
    for spec in args.repos:
        if ":" not in spec:
            raise SystemExit(f"bad arg {spec!r}, expected <repo>:<tag>")
        repo, deployed = spec.split(":", 1)
        if not deployed:
            raise SystemExit(f"empty deployed tag in {spec!r}")
        s = process_repo(host, namespace, username, token, repo, deployed,
                         args.keep_recent, args.dry_run, gh_token, gh_repo)
        summaries.append(s)

    # Compact final summary the workflow forwards to Discord.
    print("\n=== summary ===")
    for s in summaries:
        if s["dry_run"]:
            print(f"  {s['repo']}: DRY RUN — would remove {len(s['going_away'])} tags via "
                  f"{s['delete_digests']} digest DELETEs, est reclaim "
                  f"{humansize(s['reclaim_bytes'])}")
        else:
            print(f"  {s['repo']}: {s['before_tag_count']} → {s['after_tag_count']} tags "
                  f"({s['delete_digests']} digests deleted, est reclaim "
                  f"{humansize(s['reclaim_bytes'])})")


if __name__ == "__main__":
    main()
