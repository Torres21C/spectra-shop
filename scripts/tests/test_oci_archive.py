"""Integridad de los archivos OCI: lo analizado es exactamente lo que se publicará."""

import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import OTHER_SHA, SHA, load_tool, make_oci

tool = load_tool()


class OciArchiveTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_valid_archive(self):
        digest = make_oci(self.dir / "a.tar")
        info = tool.inspect_oci_archive(self.dir / "a.tar", SHA)
        self.assertEqual(info["manifest_digest"], digest)
        self.assertEqual(info["platform"], "linux/amd64")

    def test_tampered_layer_is_rejected(self):
        make_oci(self.dir / "a.tar", tamper_layer=True)
        with self.assertRaisesRegex(tool.PolicyError, "no coincide|tamaño"):
            tool.inspect_oci_archive(self.dir / "a.tar", SHA)

    def test_wrong_architecture_is_rejected(self):
        make_oci(self.dir / "a.tar", arch="arm64")
        with self.assertRaisesRegex(tool.PolicyError, "linux/amd64"):
            tool.inspect_oci_archive(self.dir / "a.tar", SHA)

    def test_image_from_other_commit_is_rejected(self):
        make_oci(self.dir / "a.tar", sha=OTHER_SHA)
        with self.assertRaisesRegex(tool.PolicyError, "es del commit"):
            tool.inspect_oci_archive(self.dir / "a.tar", SHA)

    def test_index_with_attestations_is_rejected(self):
        make_oci(self.dir / "a.tar", extra_manifest=True)
        with self.assertRaisesRegex(tool.PolicyError, "único manifiesto"):
            tool.inspect_oci_archive(self.dir / "a.tar", SHA)

    def test_index_instead_of_image_is_rejected(self):
        make_oci(self.dir / "a.tar", media_type="application/vnd.oci.image.index.v1+json")
        with self.assertRaisesRegex(tool.PolicyError, "no una imagen OCI"):
            tool.inspect_oci_archive(self.dir / "a.tar", SHA)

    def test_describe_rejects_mixed_commits(self):
        for image in tool.IMAGES:
            make_oci(self.dir / tool.archive_name(image), name=image["name"],
                     sha=OTHER_SHA if image["name"] == "db-ops" else SHA)
        self.assertEqual(tool.main(["describe", str(self.dir), "--sha", SHA]), 1)

    def test_describe_requires_all_nine_images(self):
        for image in tool.IMAGES[:-1]:
            make_oci(self.dir / tool.archive_name(image), name=image["name"])
        self.assertEqual(tool.main(["describe", str(self.dir), "--sha", SHA]), 1)

    def test_describe_rejects_invalid_sha(self):
        self.assertEqual(tool.main(["describe", str(self.dir), "--sha", "main"]), 1)


if __name__ == "__main__":
    unittest.main()
