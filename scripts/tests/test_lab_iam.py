import copy
import unittest
from unittest.mock import patch

from infra.terraform.scripts import validate_lab_iam as iam


class LabIamEscalationTests(unittest.TestCase):
    def test_repository_artifacts_are_safe(self):
        iam.validate_boundary()
        iam.validate_deployer()
        iam.validate_state_permissions()
        iam.validate_teardown_and_operator()
        iam.validate_terraform_wiring()
        iam.validate_permission_sets()

    def test_boundary_rejects_iam_capability(self):
        policy = iam.load("permissions-boundary.json", render=True)
        allowed = set().union(*(iam.actions(s) for s in iam.statements(policy) if s.get("Effect") == "Allow"))
        self.assertNotIn("iam:CreateRole", allowed)
        self.assertIn("iam:*", iam.actions(iam.by_sid(policy, "DenyPrivilegeEscalationAndBoundaryTampering")))

    def test_only_ecr_token_has_wildcard_resource(self):
        policy = iam.load("permissions-boundary.json", render=True)
        wildcard_allows = [s["Sid"] for s in iam.statements(policy) if s.get("Effect") == "Allow" and s.get("Resource") == "*"]
        self.assertEqual(wildcard_allows, ["AllowEcrAuthorizationToken"])

    def test_plan_cannot_write_or_delete_state(self):
        policy = iam.load("plan-policy.json", render=True)
        state = iam.by_sid(policy, "ReadLabState")
        self.assertEqual(iam.actions(state), {"s3:GetObject"})
        self.assertFalse({"s3:PutObject", "s3:DeleteObject"} & iam.actions(state))
        lock = iam.by_sid(policy, "ManageOnlyLabStateLock")
        self.assertTrue(str(lock["Resource"]).endswith("terraform.tfstate.tflock"))

    def test_kms_policy_and_grants_are_resource_scoped(self):
        policy = iam.load("deploy-policy.json", render=True)
        kms = iam.by_sid(policy, "ManageOnlyTaggedLabKmsKeys")
        self.assertEqual(kms["Resource"], "arn:aws:kms:us-east-1:111122223333:key/*")
        self.assertEqual(kms["Condition"]["StringEquals"]["aws:ResourceTag/Project"], "spectra-shop")
        grant = iam.by_sid(policy, "CreateGrantsOnlyForAwsResourcesOnTaggedLabKeys")
        self.assertEqual(grant["Condition"]["Bool"]["kms:GrantIsForAWSResource"], "true")

    def test_deployer_rejects_unbounded_create_role(self):
        policy = iam.load("deploy-policy.json", render=True)
        statement = iam.by_sid(policy, "DenyUnboundedRoleCreation")
        self.assertEqual(statement["Effect"], "Deny")
        self.assertEqual(statement["Condition"], {"Null": {"iam:PermissionsBoundary": "true"}})

    def test_deployer_rejects_boundary_substitution(self):
        policy = iam.load("deploy-policy.json", render=True)
        statement = iam.by_sid(policy, "DenyReplacingWithAnotherBoundary")
        self.assertEqual(statement["Effect"], "Deny")
        self.assertNotIn("Condition", statement)

    def test_teardown_cannot_exploit_boundary_removal(self):
        policy = iam.load("teardown-policy.json", render=True)
        allowed = set().union(*(iam.actions(s) for s in iam.statements(policy) if s.get("Effect") == "Allow"))
        self.assertTrue({"iam:CreateRole", "iam:PutRolePolicy", "iam:PassRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"}.isdisjoint(allowed))
        denied = iam.actions(iam.by_sid(policy, "DenyBoundaryPolicyMutationDuringTeardown"))
        self.assertIn("iam:DeleteRolePermissionsBoundary", denied)

    def test_validator_detects_mutable_boundary(self):
        unsafe = iam.load("deploy-policy.json", render=True)
        mutated = copy.deepcopy(unsafe)
        iam.by_sid(mutated, "DenyBoundaryPolicyMutation")["Effect"] = "Allow"
        original = iam.load

        def fake_load(name, render=False):
            return mutated if name == "deploy-policy.json" else original(name, render)

        with patch.object(iam, "load", side_effect=fake_load):
            with self.assertRaises(iam.ValidationError):
                iam.validate_deployer()

    def test_validator_rejects_role_scope_that_includes_publisher(self):
        deploy = iam.load("deploy-policy.json", render=True)
        iam.by_sid(deploy, "ManageOnlyBoundedLabRoles")["Resource"] = [
            "arn:aws:iam::111122223333:role/spectra-lab-*"
        ]
        original = iam.load

        with patch.object(iam, "load", side_effect=lambda name, render=False:
                          deploy if name == "deploy-policy.json" else original(name, render)):
            with self.assertRaises(iam.ValidationError):
                iam.validate_deployer()


if __name__ == "__main__":
    unittest.main()
