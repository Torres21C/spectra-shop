"""Política de vulnerabilidades aprobada (2026-11-21): CRITICAL y HIGH con corrección bloquean; HIGH sin corrección
solo con excepción explícita, aprobada y de 30 días como máximo; MEDIUM/LOW se reportan; sin exclusiones generales."""

import json
import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import load_tool

tool = load_tool()
TODAY = "2026-11-21"


def vuln(vid="CVE-2026-1000", pkg="openssl", severity="HIGH", fixed=""):
    return {"VulnerabilityID": vid, "PkgName": pkg, "Severity": severity, "FixedVersion": fixed}


def exception(**override):
    base = {"vulnerability": "CVE-2026-1000", "package": "openssl", "images": ["db-ops"], "severity": "HIGH",
            "justification": "Sin versión corregida publicada; el paquete no se usa en red en db-ops.",
            "approved_by": "Torres21C", "approved_on": "2026-11-20", "expires_on": "2026-12-15"}
    base.update(override)
    return base


class VulnPolicyTests(unittest.TestCase):
    def run_policy(self, findings=None, exceptions=(), secrets=None, image="db-ops", today=TODAY):
        release = Path(tempfile.mkdtemp())
        (release / "scans").mkdir()
        for img in tool.IMAGES:
            results = []
            if img["name"] == image and (findings or secrets):
                results = [{"Target": "x", "Vulnerabilities": findings or [], "Secrets": secrets or []}]
            (release / "scans" / f"{img['name']}.trivy.json").write_text(json.dumps({"Results": results}))
        exc = release / "exceptions.json"
        exc.write_text(json.dumps({"policy_version": 1, "exceptions": list(exceptions)}))
        code = tool.main(["vuln-policy", str(release), "--exceptions", str(exc), "--today", today])
        report = json.loads((release / "policy-report.json").read_text()) if (release / "policy-report.json").exists() else None
        return code, report

    def test_clean_images_pass(self):
        self.assertEqual(self.run_policy()[0], 0)

    def test_critical_blocks(self):
        self.assertEqual(self.run_policy([vuln(severity="CRITICAL")])[0], 1)

    def test_critical_cannot_be_excepted(self):
        code, _ = self.run_policy([vuln(severity="CRITICAL")], [exception(severity="CRITICAL")])
        self.assertEqual(code, 1)

    def test_high_with_fix_blocks(self):
        self.assertEqual(self.run_policy([vuln(fixed="3.3.2")])[0], 1)

    def test_high_with_fix_cannot_be_excepted(self):
        self.assertEqual(self.run_policy([vuln(fixed="3.3.2")], [exception()])[0], 1)

    def test_high_without_fix_blocks_without_exception(self):
        self.assertEqual(self.run_policy([vuln()])[0], 1)

    def test_high_without_fix_with_valid_exception_passes(self):
        code, report = self.run_policy([vuln()], [exception()])
        self.assertEqual(code, 0)
        self.assertEqual(len(report["excepted"]), 1)

    def test_expired_exception_blocks(self):
        self.assertEqual(self.run_policy([vuln()], [exception()], today="2026-12-16")[0], 1)

    def test_exception_longer_than_30_days_is_invalid(self):
        self.assertEqual(self.run_policy([vuln()], [exception(expires_on="2026-12-21")])[0], 1)

    def test_exception_for_other_image_does_not_apply(self):
        self.assertEqual(self.run_policy([vuln()], [exception(images=["identity-service-runtime"])])[0], 1)

    def test_wildcard_exception_is_rejected(self):
        self.assertEqual(self.run_policy([vuln()], [exception(vulnerability="CVE-*")])[0], 1)
        self.assertEqual(self.run_policy([vuln()], [exception(package="*")])[0], 1)
        self.assertEqual(self.run_policy([vuln()], [exception(images=["*"])])[0], 1)

    def test_exception_without_approver_is_rejected(self):
        self.assertEqual(self.run_policy([vuln()], [exception(approved_by="")])[0], 1)

    def test_exception_without_justification_is_rejected(self):
        self.assertEqual(self.run_policy([vuln()], [exception(justification="ok")])[0], 1)

    def test_invalid_exception_fails_even_if_unused(self):
        self.assertEqual(self.run_policy([], [exception(expires_on="2027-06-01")])[0], 1)

    def test_medium_and_low_are_reported_not_blocked(self):
        code, report = self.run_policy([vuln(severity="MEDIUM", fixed="1.2"), vuln(vid="CVE-2026-2", severity="LOW")])
        self.assertEqual(code, 0)
        self.assertEqual(report["reported_counts"]["MEDIUM"], 1)
        self.assertEqual(report["reported_counts"]["LOW"], 1)

    def test_secret_in_image_blocks(self):
        self.assertEqual(self.run_policy(secrets=[{"RuleID": "github-pat"}])[0], 1)

    def test_missing_scan_report_fails(self):
        release = Path(tempfile.mkdtemp())
        exc = release / "e.json"
        exc.write_text(json.dumps({"policy_version": 1, "exceptions": []}))
        self.assertEqual(tool.main(["vuln-policy", str(release), "--exceptions", str(exc)]), 1)

    def test_repository_exceptions_file_is_valid_and_empty(self):
        data = json.loads((tool.Path(__file__).resolve().parents[2] / "security/image-vulnerability-exceptions.json").read_text())
        self.assertEqual(data, {"policy_version": 1, "exceptions": []})


class RuntimeContentsTests(unittest.TestCase):
    def run_check(self, components, lock_packages):
        release = Path(tempfile.mkdtemp())
        (release / "sbom").mkdir()
        for img in tool.IMAGES:
            comps = components if img["kind"] == "runtime" else [{"name": "prisma", "version": "6.0.0", "purl": "pkg:npm/prisma@6.0.0"}]
            (release / "sbom" / f"{img['name']}.cdx.json").write_text(json.dumps({"components": comps}))
        lock = release / "package-lock.json"
        lock.write_text(json.dumps({"packages": lock_packages}))
        return tool.main(["runtime-contents", str(release), "--lockfile", str(lock)])

    PROD = {"node_modules/@nestjs/core": {"version": "11.0.0"}}

    def comp(self, name, version, group=None):
        return {"name": name, "version": version, "group": group, "purl": f"pkg:npm/{name}@{version}"}

    def test_production_only_passes(self):
        self.assertEqual(self.run_check([self.comp("core", "11.0.0", "@nestjs")], self.PROD), 0)

    def test_dev_dependency_in_runtime_fails(self):
        lock = {**self.PROD, "node_modules/left-pad": {"version": "1.0.0", "dev": True}}
        self.assertEqual(self.run_check([self.comp("core", "11.0.0", "@nestjs"), self.comp("left-pad", "1.0.0")], lock), 1)

    def test_dev_optional_in_runtime_fails(self):
        lock = {**self.PROD, "node_modules/typescript": {"version": "5.9.0", "devOptional": True}}
        self.assertEqual(self.run_check([self.comp("core", "11.0.0", "@nestjs"), self.comp("typescript", "5.9.0")], lock), 1)

    def test_package_that_is_also_production_passes(self):
        lock = {**self.PROD, "node_modules/semver": {"version": "7.0.0"},
                "apps/web/node_modules/semver": {"version": "7.0.0", "dev": True}}
        self.assertEqual(self.run_check([self.comp("core", "11.0.0", "@nestjs"), self.comp("semver", "7.0.0")], lock), 0)

    def test_denylisted_tool_fails_even_if_not_in_lockfile(self):
        self.assertEqual(self.run_check([self.comp("core", "11.0.0", "@nestjs"), self.comp("picomatch", "4.0.7")], self.PROD), 1)

    def test_empty_sbom_fails(self):
        self.assertEqual(self.run_check([], self.PROD), 1)


if __name__ == "__main__":
    unittest.main()
