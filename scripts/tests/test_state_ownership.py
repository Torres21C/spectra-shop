"""Propiedad de los recursos entre las raíces de Terraform (PR-6.2): pruebas positivas y negativas sin red ni AWS.

Cada prueba negativa copia infra/terraform a un directorio temporal, introduce un único cambio prohibido y
exige que infra/terraform/scripts/check_state_ownership.py lo detecte con un mensaje concreto.
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import ROOT, load_tool

ownership = load_tool("check_state_ownership", "infra/terraform/scripts/check_state_ownership.py")
TF = ROOT / "infra/terraform"


class StateOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "terraform"
        shutil.copytree(TF, self.root, ignore=shutil.ignore_patterns(".terraform", "tests", "docs", "*.md"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def errors(self):
        return ownership.analyze(self.root)[0]

    def append(self, rel, text):
        path = self.root / rel
        path.write_text(path.read_text() + "\n" + text + "\n")

    def replace(self, rel, old, new):
        path = self.root / rel
        content = path.read_text()
        self.assertIn(old, content, f"{rel}: el fragmento a modificar ya no existe")
        path.write_text(content.replace(old, new, 1))

    def assertFails(self, fragment):
        errors = self.errors()
        self.assertTrue(any(fragment in e for e in errors), f"se esperaba un error con {fragment!r}; errores: {errors}")

    # ------------------------------------------------------------------ positivo

    def test_real_tree_passes(self):
        errors, info = ownership.analyze(TF)
        self.assertEqual(errors, [])
        self.assertEqual(set(info["types"]["publisher"]), ownership.ALLOWED["publisher"])

    def test_publisher_has_no_deployment_resources(self):
        types = set(ownership.analyze(TF)[1]["types"]["publisher"])
        for prefix in ("aws_ecs_", "aws_db_", "aws_rds_", "aws_lb", "aws_vpc", "aws_subnet", "aws_cloudfront_",
                       "aws_wafv2_", "aws_secretsmanager_", "aws_kms_", "aws_s3_", "aws_cloudwatch_"):
            self.assertFalse([t for t in types if t.startswith(prefix)], prefix)

    def test_no_type_is_shared_between_publisher_and_bootstrap(self):
        info = ownership.analyze(TF)[1]["types"]
        self.assertEqual(set(info["publisher"]) & set(info["bootstrap"]), set())

    def test_comments_are_ignored(self):
        self.append("publisher/main.tf", '# resource "aws_ecs_cluster" "comentado" {}\n/* resource "aws_db_instance" "x" {} */')
        self.assertEqual(self.errors(), [])

    # ------------------------------------------------------------------ negativos

    def test_publisher_cannot_create_ecs(self):
        self.append("publisher/main.tf", 'resource "aws_ecs_cluster" "x" {\n  name = "x"\n}')
        self.assertFails("publisher: recurso no permitido en esta raíz: aws_ecs_cluster.x")

    def test_publisher_cannot_call_lab_modules(self):
        self.append("publisher/main.tf", 'module "database" {\n  source = "../modules/database"\n}')
        self.assertFails("module.database.aws_db_instance")

    def test_publisher_cannot_use_cmk_for_ecr(self):
        self.replace("publisher/main.tf", "  force_delete = var.ecr_force_delete",
                     '  kms_key_arn  = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"\n'
                     "  force_delete = var.ecr_force_delete")
        self.assertFails("D2")

    def test_lab_cannot_create_ecr_repositories(self):
        self.append("environments/lab/main.tf", 'resource "aws_ecr_repository" "dup" {\n  name = "spectra/db-ops"\n}')
        self.assertFails("aws_ecr_repository.dup (aws_ecr_repository) solo puede administrarlo la raíz publisher")

    def test_lab_cannot_call_registry_or_publisher_modules(self):
        self.append("environments/lab/main.tf", 'module "registry2" {\n  source = "../../modules/registry"\n}')
        self.assertFails("el módulo registry2 (modules/registry) solo puede usarlo la raíz publisher")

    def test_lab_cannot_create_oidc_provider(self):
        self.append("environments/lab/main.tf", 'resource "aws_iam_openid_connect_provider" "gh" {\n  url = "x"\n}')
        self.assertFails("solo puede administrarlo la raíz publisher")

    def test_lab_cannot_redeclare_publisher_switch(self):
        self.append("environments/lab/variables.tf", 'variable "enable_ecr_publisher" {\n  type = bool\n}')
        self.assertFails("lab: la variable enable_ecr_publisher pertenece a infra/terraform/publisher")

    def test_lab_must_read_repositories(self):
        self.replace("environments/lab/main.tf", 'data "aws_ecr_repository" "this" {', 'locals {\n  unused_data = {\n')
        self.replace("environments/lab/main.tf", '  name = "spectra/${each.key}"\n}', '  }\n}')
        self.assertFails('lab: debe leer los repositorios con data "aws_ecr_repository"')

    def test_no_remote_state_between_roots(self):
        self.append("environments/lab/main.tf", 'data "terraform_remote_state" "publisher" {\n  backend = "s3"\n}')
        self.assertFails("terraform_remote_state")

    def test_cloudtrail_only_in_bootstrap(self):
        self.append("environments/lab/main.tf", 'resource "aws_cloudtrail" "x" {\n  name = "x"\n}')
        self.assertFails("solo puede administrarlo la raíz bootstrap")

    def test_repository_lists_must_match(self):
        self.replace("environments/lab/main.tf", '"audit-service", "db-ops"]', '"audit-service", "db-ops", "web"]')
        self.assertFails("mismos 5 repositorios")

    def test_audit_bucket_keeps_prevent_destroy(self):
        self.replace("bootstrap/audit.tf", "prevent_destroy = true", "prevent_destroy = false")
        self.assertFails("aws_s3_bucket.audit debe tener lifecycle")

    def test_state_key_keeps_prevent_destroy(self):
        self.replace("bootstrap/main.tf", 'enable_key_rotation     = true\n  deletion_window_in_days = 30\n  policy                  = data.aws_iam_policy_document.state_key.json\n\n  lifecycle {\n    prevent_destroy = true',
                     'enable_key_rotation     = true\n  deletion_window_in_days = 30\n  policy                  = data.aws_iam_policy_document.state_key.json\n\n  lifecycle {\n    prevent_destroy = false')
        self.assertFails("aws_kms_key.state debe tener lifecycle")

    def test_bootstrap_cannot_create_other_resources(self):
        self.append("bootstrap/main.tf", 'resource "aws_iam_role" "x" {\n  name = "x"\n}')
        self.assertFails("bootstrap: recurso no permitido en esta raíz: aws_iam_role.x")


if __name__ == "__main__":
    unittest.main()
