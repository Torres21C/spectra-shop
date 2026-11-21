"""Scripts de shell del job publish con aws/skopeo/gh/git SIMULADOS (sin AWS ni GitHub): fallo seguro (G),
idempotencia y no sobrescritura de etiquetas inmutables (D)."""

import json
import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from scripts.tests.helpers import ROOT, SHA, load_tool, make_release

tool = load_tool()
ACCOUNT = "111122223333"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/spectra-lab-ecr-publisher"

AWS_STUB = r'''#!/bin/sh
case "$1 $2" in
  "sts get-caller-identity") echo "${STUB_CALLER}" ;;
  "ecr get-login-password") echo token ;;
  "ecr describe-images")
    repo=""; tag=""
    while [ $# -gt 0 ]; do case "$1" in --repository-name) repo=$2; shift;; --image-ids) tag=${2#imageTag=}; shift;; esac; shift; done
    [ -n "$STUB_DESCRIBE_ERROR" ] && { echo "$STUB_DESCRIBE_ERROR" >&2; exit 254; }
    f="$STUB_DIR/remote/$(echo "$repo" | tr / _)__$tag"
    if [ -f "$f" ]; then cat "$f"; else echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2; exit 254; fi ;;
  *) echo "aws: llamada no esperada: $*" >&2; exit 99 ;;
esac
'''

SKOPEO_STUB = r'''#!/bin/sh
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  logout) exit 0 ;;
  copy)
    for a in "$@"; do case "$a" in oci-archive:*) src=${a#oci-archive:};; docker://*) dst=${a#docker://};; --preserve-digests) pd=1;; esac; done
    [ "$pd" = 1 ] || { echo "skopeo copy sin --preserve-digests" >&2; exit 98; }
    echo "$src -> $dst" >> "$STUB_DIR/copies.log"
    ref=${dst#*/}; repo=${ref%%:*}; tag=${ref#*:}
    digest=$(python3 -I -c 'import json,sys,tarfile;t=tarfile.open(sys.argv[1]);print(json.load(t.extractfile("index.json"))["manifests"][0]["digest"])' "$src")
    [ -n "$STUB_PUSH_DIGEST" ] && digest=$STUB_PUSH_DIGEST
    mkdir -p "$STUB_DIR/remote"; echo "$digest" > "$STUB_DIR/remote/$(echo "$repo" | tr / _)__$tag" ;;
  *) echo "skopeo: llamada no esperada: $*" >&2; exit 99 ;;
esac
'''


def write_stub(directory: Path, name: str, body: str) -> None:
    path = directory / name
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class PublishImagesTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.release = self.dir / "release"
        self.doc = make_release(tool, self.release)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        write_stub(self.bin, "aws", AWS_STUB)
        write_stub(self.bin, "skopeo", SKOPEO_STUB)

    def env(self, **extra):
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "STUB_DIR": str(self.dir),
               "STUB_CALLER": f"arn:aws:sts::{ACCOUNT}:assumed-role/spectra-lab-ecr-publisher/spectra-ecr-publish-1",
               "AWS_REGION": "us-east-1", "AWS_ACCOUNT_ID": ACCOUNT, "COMMIT_SHA": SHA, "GITHUB_STEP_SUMMARY": "/dev/null"}
        env.update(extra)
        return env

    def publish(self, **extra):
        return subprocess.run(["bash", "scripts/ecr/publish-images.sh", str(self.release)], cwd=ROOT,
                              env=self.env(**extra), capture_output=True, text=True)

    def copies(self):
        log = self.dir / "copies.log"
        return log.read_text().splitlines() if log.exists() else []

    def preload(self, name, digest):
        entry = next(e for e in self.doc["images"] if e["name"] == name)
        (self.dir / "remote").mkdir(exist_ok=True)
        (self.dir / "remote" / f"{entry['repository'].replace('/', '_')}__{entry['tag']}").write_text(digest + "\n")

    def test_publishes_nine_images_and_writes_manifest(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.copies()), 9)
        manifest = json.loads((self.release / "release-manifest.json").read_text())
        self.assertEqual({i["publication"] for i in manifest["images"]}, {"published"})
        self.assertTrue(all(f"{ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/spectra/" in i["reference_by_digest"] for i in manifest["images"]))

    def test_idempotent_when_same_digest_exists(self):
        entry = self.doc["images"][0]
        self.preload(entry["name"], entry["manifest_digest"])
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.copies()), 8)
        manifest = json.loads((self.release / "release-manifest.json").read_text())
        states = {i["name"]: i["publication"] for i in manifest["images"]}
        self.assertEqual(states[entry["name"]], "already-present")

    def test_existing_tag_with_other_digest_aborts_before_any_copy(self):
        self.preload("db-ops", "sha256:" + "e" * 64)
        result = self.publish()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.copies(), [])
        self.assertIn("no se sobrescribe", result.stderr)

    def test_access_denied_fails_safely(self):
        result = self.publish(STUB_DESCRIBE_ERROR="An error occurred (AccessDeniedException)")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.copies(), [])

    def test_missing_repository_fails_safely(self):
        result = self.publish(STUB_DESCRIBE_ERROR="An error occurred (RepositoryNotFoundException)")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.copies(), [])

    def test_unexpected_identity_fails(self):
        result = self.publish(STUB_CALLER=f"arn:aws:sts::{ACCOUNT}:assumed-role/Admin/someone")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.copies(), [])

    def test_digest_changed_by_registry_fails(self):
        result = self.publish(STUB_PUSH_DIGEST="sha256:" + "d" * 64)
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.release / "release-manifest.json").exists())


class CheckPublishConfigTests(unittest.TestCase):
    BASE = {"GITHUB_REF": "refs/heads/main", "AWS_REGION": "us-east-1", "AWS_ACCOUNT_ID": ACCOUNT,
            "AWS_ECR_PUBLISHER_ROLE_ARN": ROLE, "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.invalid",
            "COMMIT_SHA": SHA, "EXPECTED_DIGESTS_SHA256": "a" * 64}

    def check(self, **override):
        env = {"PATH": os.environ["PATH"], **self.BASE, **override}
        env = {k: v for k, v in env.items() if v is not None}
        return subprocess.run(["bash", "scripts/ecr/check-publish-config.sh"], cwd=ROOT, env=env,
                              capture_output=True, text=True).returncode

    def test_complete_configuration(self):
        self.assertEqual(self.check(), 0)

    def test_missing_variables_fail(self):
        for key in ("AWS_REGION", "AWS_ACCOUNT_ID", "AWS_ECR_PUBLISHER_ROLE_ARN", "ACTIONS_ID_TOKEN_REQUEST_URL",
                    "EXPECTED_DIGESTS_SHA256"):
            with self.subTest(key=key):
                self.assertEqual(self.check(**{key: None}), 1)

    def test_other_role_fails(self):
        self.assertEqual(self.check(AWS_ECR_PUBLISHER_ROLE_ARN=f"arn:aws:iam::{ACCOUNT}:role/Admin"), 1)
        self.assertEqual(self.check(AWS_ECR_PUBLISHER_ROLE_ARN="arn:aws:iam::999999999999:role/spectra-lab-ecr-publisher"), 1)

    def test_other_region_or_branch_fails(self):
        self.assertEqual(self.check(AWS_REGION="eu-west-1"), 1)
        self.assertEqual(self.check(GITHUB_REF="refs/heads/feature/x"), 1)


class VerifyPublishRefScriptTests(unittest.TestCase):
    """verify-publish-ref.sh con gh y git simulados: un Environment inexistente impide publicar."""

    def run_script(self, environment_exists: bool, publish: str = "true", sha: str = SHA):
        d = Path(tempfile.mkdtemp())
        bin_dir = d / "bin"
        bin_dir.mkdir()
        checks = {"check_runs": [{"name": n, "head_sha": SHA, "status": "completed", "conclusion": "success",
                                  "app": {"id": 15368}, "check_suite": {"id": 102 if n.startswith("Terraform") else 101}}
                                 for n in tool.REQUIRED_CHECKS]}
        runs = {"workflow_runs": [{"head_sha": SHA, "event": "push", "head_branch": "main", "status": "completed",
                                   "conclusion": "success", "path": p, "check_suite_id": s}
                                  for p, s in ((".github/workflows/ci.yml", 101), (".github/workflows/iac.yml", 102))]}
        (d / "checks.json").write_text(json.dumps(checks))
        (d / "runs.json").write_text(json.dumps(runs))
        write_stub(bin_dir, "gh", textwrap.dedent(f'''\
            #!/bin/sh
            case "$2" in
              *check-runs*) cat "{d}/checks.json" ;;
              *actions/runs*) cat "{d}/runs.json" ;;
              *deployment-branch-policies) echo '{{"branch_policies":[{{"name":"main","type":"branch"}}]}}' ;;
              *environments/*) {"echo '" + json.dumps({"name": "ecr-publish-lab", "can_admins_bypass": False, "protection_rules": [{"type": "required_reviewers", "reviewers": [{"type": "User"}]}], "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}) + "'" if environment_exists else "echo 'Not Found' >&2; exit 1"} ;;
              *) exit 99 ;;
            esac
            '''))
        write_stub(bin_dir, "git", f'#!/bin/sh\ncase "$1" in fetch) exit 0;; rev-list) echo {SHA};; *) exit 99;; esac\n')
        env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "COMMIT_SHA": sha, "PUBLISH": publish,
               "PUBLISH_ENVIRONMENT": "ecr-publish-lab", "GITHUB_REPOSITORY": "Torres21C/spectra-shop",
               "GITHUB_REF": "refs/heads/main", "GITHUB_OUTPUT": str(d / "out"), "GH_TOKEN": "x"}
        result = subprocess.run(["bash", str(ROOT / "scripts/ecr/verify-publish-ref.sh")], cwd=ROOT, env=env,
                                capture_output=True, text=True)
        return result.returncode, (d / "out").read_text() if (d / "out").exists() else ""

    def test_existing_protected_environment(self):
        code, out = self.run_script(environment_exists=True)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), f"sha={SHA}")

    def test_missing_environment_blocks_publication(self):
        self.assertEqual(self.run_script(environment_exists=False)[0], 1)

    def test_dry_run_does_not_query_environment(self):
        self.assertEqual(self.run_script(environment_exists=False, publish="false")[0], 0)

    def test_injection_attempt_in_sha_is_rejected(self):
        self.assertEqual(self.run_script(True, sha='$(touch /tmp/pwned)')[0], 1)


if __name__ == "__main__":
    unittest.main()
