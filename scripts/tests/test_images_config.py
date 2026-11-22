"""Las 9 imágenes del pipeline coinciden con Terraform (repositorios y etiquetas) y con los Dockerfiles reales."""

import re
import unittest

from scripts.tests.helpers import ROOT, load_tool

tool = load_tool()


class ImagesConfigTests(unittest.TestCase):
    def test_nine_images(self):
        self.assertEqual(len(tool.IMAGES), 9)
        self.assertEqual(sum(1 for i in tool.IMAGES if i["kind"] == "runtime"), 4)
        self.assertEqual(sum(1 for i in tool.IMAGES if i["kind"] == "migrate"), 4)

    def test_repositories_match_terraform(self):
        # PR-6.2: los crea infra/terraform/publisher y los lee environments/lab; deben coincidir en ambas raíces.
        for root in ("infra/terraform/publisher", "infra/terraform/environments/lab"):
            main_tf = (ROOT / root / "main.tf").read_text()
            repos = re.search(r"repositories\s*=\s*\[([^\]]*)\]", main_tf).group(1)
            terraform = {f"spectra/{r}" for r in re.findall(r'"([^"]+)"', repos)}
            self.assertEqual({i["repository"] for i in tool.IMAGES}, terraform, root)

    def test_tag_suffixes_match_ecs_task_definitions(self):
        workloads = (ROOT / "infra/terraform/modules/ecs/workloads.tf").read_text()
        for svc in ("identity", "catalog", "commerce", "audit"):
            pattern = (svc + r'-migrate\s*=\s*\{\s*repository\s*=\s*"' + svc +
                       r'-service"\s*image_tag\s*=\s*"\$\{var\.image_tag\}-migrate"')
            self.assertRegex(workloads, pattern, f"{svc}-migrate debe usar {svc}-service:<sha>-migrate")
        for op in ("db-provision", "db-finalize"):
            self.assertRegex(workloads, op + r'\s*=\s*\{\s*repository\s*=\s*"db-ops"\s*image_tag\s*=\s*var\.image_tag\b')
        migrate = {i["repository"]: i["tag_suffix"] for i in tool.IMAGES if i["kind"] == "migrate"}
        self.assertTrue(all(s == "-migrate" for s in migrate.values()))
        self.assertTrue(all(i["tag_suffix"] == "" for i in tool.IMAGES if i["kind"] != "migrate"))

    def test_dockerfile_targets_exist(self):
        for image in tool.IMAGES:
            dockerfile = (ROOT / image["dockerfile"]).read_text()
            stages = set(re.findall(r"^FROM\s+\S+\s+AS\s+(\S+)", dockerfile, re.M))
            if image["target"]:
                self.assertIn(image["target"], stages, image["name"])
            self.assertTrue((ROOT / image["context"]).is_dir())

    def test_runtime_is_final_stage(self):
        for image in tool.IMAGES:
            if image["kind"] == "runtime":
                dockerfile = (ROOT / image["dockerfile"]).read_text()
                self.assertEqual(re.findall(r"^FROM\s+\S+\s+AS\s+(\S+)", dockerfile, re.M)[-1], "runtime")

    def test_base_images_pinned_by_digest(self):
        for image in tool.IMAGES:
            for line in re.findall(r"^FROM\s+(\S+)", (ROOT / image["dockerfile"]).read_text(), re.M):
                self.assertRegex(line, r"@sha256:[0-9a-f]{64}$", image["dockerfile"])

    def test_cpu_architecture_matches_terraform_default(self):
        variables = (ROOT / "infra/terraform/environments/lab/variables.tf").read_text()
        block = re.search(r'variable "cpu_architecture" \{(.*?)\n\}', variables, re.S).group(1)
        self.assertIn('default     = "X86_64"', block)
        self.assertEqual(tool.PLATFORM, {"os": "linux", "architecture": "amd64"})

    def test_buildkit_pinned_by_digest(self):
        self.assertRegex(tool.BUILDKIT_IMAGE, r"^moby/buildkit:v[0-9.]+@sha256:[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
