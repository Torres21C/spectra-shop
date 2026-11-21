"""Integridad entre build-scan y publish (control D) y manifiesto de publicación."""

import json
import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import OTHER_SHA, SHA, load_tool, make_oci, make_release

tool = load_tool()


class VerifyReleaseTests(unittest.TestCase):
    def setUp(self):
        self.release = Path(tempfile.mkdtemp())
        make_release(tool, self.release)
        self.expected = tool.sha256_file(self.release / "images.json")

    def verify(self, sha=SHA, expected=None):
        return tool.main(["verify-release", str(self.release), "--sha", sha,
                          "--expected-images-sha256", expected or self.expected])

    def test_intact_release_passes(self):
        self.assertEqual(self.verify(), 0)

    def test_modified_images_json_fails(self):
        self.assertEqual(self.verify(expected="0" * 64), 1)

    def test_other_commit_fails(self):
        self.assertEqual(self.verify(sha=OTHER_SHA), 1)

    def test_replaced_archive_fails(self):
        image = tool.IMAGES[0]
        make_oci(self.release / tool.archive_name(image), name="otra")
        self.assertEqual(self.verify(), 1)

    def test_missing_archive_fails(self):
        (self.release / tool.archive_name(tool.IMAGES[3])).unlink()
        self.assertEqual(self.verify(), 1)

    def test_failed_policy_blocks(self):
        (self.release / "policy-report.json").write_text(json.dumps({"status": "fail"}))
        self.assertEqual(self.verify(), 1)

    def test_missing_runtime_report_blocks(self):
        (self.release / "runtime-contents.json").unlink()
        self.assertEqual(self.verify(), 1)

    def test_tags_follow_terraform_convention(self):
        doc = json.loads((self.release / "images.json").read_text())
        tags = {e["name"]: e["tag"] for e in doc["images"]}
        self.assertEqual(tags["identity-service-runtime"], SHA)
        self.assertEqual(tags["identity-service-migrate"], SHA + "-migrate")
        self.assertEqual(tags["db-ops"], SHA)
        self.assertFalse(any("latest" in t for t in tags.values()))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.release = Path(tempfile.mkdtemp())
        self.doc = make_release(tool, self.release)
        self.states = self.release / "states.json"

    def write_states(self, override=None):
        states = {e["name"]: {"digest": e["manifest_digest"], "publication": "published"} for e in self.doc["images"]}
        states.update(override or {})
        self.states.write_text(json.dumps(states))

    def test_manifest_links_commit_tags_and_digests(self):
        self.write_states()
        registry = "111122223333.dkr.ecr.us-east-1.amazonaws.com"
        self.assertEqual(tool.main(["manifest", str(self.release), "--states", str(self.states), "--registry", registry]), 0)
        manifest = json.loads((self.release / "release-manifest.json").read_text())
        self.assertEqual(manifest["commit"], SHA)
        self.assertEqual(manifest["terraform"]["image_tag"], SHA)
        self.assertEqual(len(manifest["images"]), 9)
        for image in manifest["images"]:
            self.assertTrue(image["reference_by_digest"].endswith("@" + image["digest"]))
            self.assertIn(":" + image["tag"], image["reference_by_tag"])

    def test_manifest_rejects_published_digest_mismatch(self):
        self.write_states({"db-ops": {"digest": "sha256:" + "f" * 64, "publication": "published"}})
        self.assertEqual(tool.main(["manifest", str(self.release), "--states", str(self.states), "--registry", "r"]), 1)


if __name__ == "__main__":
    unittest.main()
