"""Control A y G: SHA de main (first-parent), 5 checks de ese commit en push de main, Environment protegido."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import SHA, load_tool

tool = load_tool()
FEATURE_SHA = "1111111111111111111111111111111111111111"


def runs(**override):
    base = [{"head_sha": SHA, "event": "push", "head_branch": "main", "status": "completed", "conclusion": "success",
             "path": path, "check_suite_id": suite} for path, suite in
            ((".github/workflows/ci.yml", 101), (".github/workflows/iac.yml", 102))]
    for run in base:
        run.update(override)
    return {"workflow_runs": base}


def checks(**override):
    suite = {"Terraform (validación estática, sin AWS)": 102}
    data = [{"name": n, "head_sha": SHA, "status": "completed", "conclusion": "success",
             "app": {"id": 15368, "slug": "github-actions"}, "check_suite": {"id": suite.get(n, 101)}}
            for n in tool.REQUIRED_CHECKS]
    for c in data:
        c.update(override)
    return {"check_runs": data}


ENVIRONMENT = {"name": "ecr-publish-lab", "can_admins_bypass": False,
               "protection_rules": [{"type": "required_reviewers", "prevent_self_review": False,
                                     "reviewers": [{"type": "User", "reviewer": {"login": "Torres21C"}}]},
                                    {"type": "branch_policy"}],
               "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}
POLICIES = {"branch_policies": [{"name": "main", "type": "branch"}]}


class VerifyRefTests(unittest.TestCase):
    def run_tool(self, sha=SHA, ref="refs/heads/main", first_parent=(SHA,), check_runs=None, workflow_runs=None,
                 publish="false", environment=ENVIRONMENT, policies=POLICIES):
        d = Path(tempfile.mkdtemp())
        (d / "fp").write_text("\n".join(first_parent) + "\n")
        (d / "checks").write_text(json.dumps(check_runs or checks()))
        (d / "runs").write_text(json.dumps(workflow_runs or runs()))
        args = ["verify-ref", "--sha", sha, "--ref", ref, "--first-parent", str(d / "fp"), "--check-runs",
                str(d / "checks"), "--workflow-runs", str(d / "runs"), "--publish", publish]
        if environment is not None:
            (d / "env").write_text(json.dumps(environment))
            args += ["--environment", str(d / "env")]
        if policies is not None:
            (d / "pol").write_text(json.dumps(policies))
            args += ["--branch-policies", str(d / "pol")]
        return tool.main(args)

    def test_valid_commit_dry_run(self):
        self.assertEqual(self.run_tool(), 0)

    def test_valid_commit_publish(self):
        self.assertEqual(self.run_tool(publish="true"), 0)

    def test_invalid_sha(self):
        self.assertEqual(self.run_tool(sha="HEAD"), 1)
        self.assertEqual(self.run_tool(sha=SHA.upper()), 1)

    def test_dispatch_from_other_branch(self):
        self.assertEqual(self.run_tool(ref="refs/heads/feature/x"), 1)

    def test_ancestor_but_not_first_parent_is_rejected(self):
        # Commit de una rama de feature integrado por merge: ancestro de main, pero no código autorizado de main.
        self.assertEqual(self.run_tool(sha=FEATURE_SHA, first_parent=(SHA,)), 1)

    def test_missing_check(self):
        data = checks()
        data["check_runs"] = [c for c in data["check_runs"] if c["name"] != "SAST (Semgrep)"]
        self.assertEqual(self.run_tool(check_runs=data), 1)

    def test_failed_check(self):
        data = checks()
        data["check_runs"][0]["conclusion"] = "failure"
        self.assertEqual(self.run_tool(check_runs=data), 1)

    def test_check_from_other_app(self):
        data = checks()
        data["check_runs"][1]["app"] = {"id": 999, "slug": "otra-app"}
        self.assertEqual(self.run_tool(check_runs=data), 1)

    def test_check_from_pull_request_run_is_rejected(self):
        data = checks()
        data["check_runs"][2]["check_suite"] = {"id": 555}  # suite de una ejecución pull_request
        self.assertEqual(self.run_tool(check_runs=data), 1)

    def test_check_of_other_commit(self):
        self.assertEqual(self.run_tool(check_runs=checks(head_sha=FEATURE_SHA)), 1)

    def test_workflow_run_from_pull_request(self):
        self.assertEqual(self.run_tool(workflow_runs=runs(event="pull_request")), 1)

    def test_workflow_run_failed(self):
        self.assertEqual(self.run_tool(workflow_runs=runs(conclusion="failure")), 1)

    def test_missing_iac_workflow(self):
        data = runs()
        data["workflow_runs"] = data["workflow_runs"][:1]
        self.assertEqual(self.run_tool(workflow_runs=data), 1)

    def test_publish_without_environment(self):
        self.assertEqual(self.run_tool(publish="true", environment=None), 1)

    def test_environment_auto_created_without_reviewers(self):
        env = copy.deepcopy(ENVIRONMENT)
        env["protection_rules"] = []
        env["deployment_branch_policy"] = None
        self.assertEqual(self.run_tool(publish="true", environment=env), 1)

    def test_environment_open_to_all_branches(self):
        env = copy.deepcopy(ENVIRONMENT)
        env["deployment_branch_policy"] = None
        self.assertEqual(self.run_tool(publish="true", environment=env), 1)

    def test_environment_protected_branches_mode(self):
        env = copy.deepcopy(ENVIRONMENT)
        env["deployment_branch_policy"] = {"protected_branches": True, "custom_branch_policies": False}
        self.assertEqual(self.run_tool(publish="true", environment=env), 1)

    def test_environment_allows_extra_branch(self):
        self.assertEqual(self.run_tool(publish="true", policies={"branch_policies": [
            {"name": "main", "type": "branch"}, {"name": "release/*", "type": "branch"}]}), 1)

    def test_environment_allows_tag_policy(self):
        self.assertEqual(self.run_tool(publish="true", policies={"branch_policies": [{"name": "main", "type": "tag"}]}), 1)

    def test_dry_run_does_not_need_environment(self):
        self.assertEqual(self.run_tool(publish="false", environment=None, policies=None), 0)


if __name__ == "__main__":
    unittest.main()
