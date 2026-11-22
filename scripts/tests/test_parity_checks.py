"""PR-7A: pruebas del helper de paridad local con ECS (scripts/ecs-parity/parity_checks.py), sin Docker ni AWS.

La configuración de referencia reproduce la forma de `docker compose config --format json` del override
infra/ecs-parity/compose.ecs-parity.yaml. Cada prueba negativa aplica un único cambio que relajaría un control
de la task definition y exige que la comprobación lo detecte.
"""

import copy
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from scripts.tests.helpers import load_tool

parity = load_tool("parity_checks", "scripts/ecs-parity/parity_checks.py")

PORTS = {"identity-service": 3001, "catalog-service": 3002, "commerce-service": 3003, "audit-service": 3004}
URL = "postgresql://u:p@postgres:5432/db?schema=s&sslmode=require&connection_limit=5"


def valid_config():
    services = {}
    for name, port in PORTS.items():
        env = {key: "x" for key in parity.ECS_ENV[name] | parity.LOCAL_ONLY_ENV.get(name, set())}
        env.update({k: v for k, v in parity.EXPECTED_VALUES.items() if k in env})
        env.update({k: URL for k in parity.DB_URL_KEYS if k in env})
        env["PORT"] = str(port)
        services[name] = {
            "image": f"spectra-pr7a/{name}-runtime:tag",
            "read_only": True,
            "cap_drop": ["ALL"],
            "init": True,
            "platform": "linux/amd64",
            "pull_policy": "never",
            "healthcheck": {
                "test": ["CMD", "node", "-e", f"fetch('http://127.0.0.1:{port}/health').then(r=>r)"],
                "interval": "15s",
                "timeout": "5s",
                "retries": 3,
                "start_period": "30s",
            },
            "environment": env,
        }
    for job in parity.JOBS:
        env = (
            {"PGSSLMODE": "require", "PGUSER": "rds_master"}
            if job.startswith("postgres-")
            else {"X_DATABASE_URL": URL.replace("connection_limit=5", "connection_limit=5")}
        )
        services[job] = {"cap_drop": ["ALL"], "init": True, "read_only": False, "platform": "linux/amd64", "environment": env}
    services["postgres"] = {
        "entrypoint": ["sh", "-c", "printf 'local all all trust\\nhostssl all all all scram-sha-256\\nhostnossl all all all reject\\n'"],
        "command": [
            "postgres",
            "-c", "ssl=on",
            "-c", "ssl_min_protocol_version=TLSv1.2",
            "-c", "hba_file=/etc/pgtls/pg_hba.conf",
            "-c", "log_statement=none",
            "-c", "log_min_duration_statement=-1",
            "-c", "log_min_error_statement=panic",
            "-c", "log_connections=on",
            "-c", "log_disconnections=on",
        ],
    }
    return {"services": services}


class CheckConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_check(self, config):
        path = self.tmp / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            code = parity.check_config(str(path))
        report = json.loads(out.getvalue())
        return code, [f'{c["target"]}: {c["check"]}' for c in report["checks"] if not c["ok"]]

    def test_valid_configuration_passes(self):
        code, failed = self.run_check(valid_config())
        self.assertEqual((code, failed), (0, []))

    def assert_detected(self, mutate, expected_fragment):
        config = valid_config()
        mutate(config["services"])
        code, failed = self.run_check(config)
        self.assertEqual(code, 1)
        self.assertTrue(any(expected_fragment in f for f in failed), failed)

    def test_writable_root_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"].update(read_only=False), "identity-service: read_only=true")

    def test_capability_added_is_detected(self):
        self.assert_detected(lambda s: s["catalog-service"].update(cap_add=["NET_ADMIN"]), "catalog-service: sin cap_add")

    def test_capabilities_not_dropped_is_detected(self):
        self.assert_detected(lambda s: s["audit-service"].update(cap_drop=[]), "audit-service: cap_drop=[ALL]")

    def test_missing_init_is_detected(self):
        self.assert_detected(lambda s: s["commerce-service"].update(init=False), "commerce-service: init=true")

    def test_privileged_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"].update(privileged=True), "privileged")

    def test_explicit_user_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"].update(user="root"), "sin user")

    def test_writable_volume_is_detected(self):
        self.assert_detected(
            lambda s: s["commerce-service"].update(volumes=[{"type": "tmpfs", "target": "/tmp"}]), "commerce-service: sin volúmenes"
        )

    def test_tmpfs_is_detected(self):
        self.assert_detected(lambda s: s["catalog-service"].update(tmpfs=["/tmp"]), "sin tmpfs")

    def test_security_opt_is_detected(self):
        self.assert_detected(lambda s: s["audit-service"].update(security_opt=["seccomp:unconfined"]), "security_opt")

    def test_other_platform_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"].update(platform="linux/arm64"), "platform=linux/amd64")

    def test_local_build_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"].update(build={"context": "."}), "sin build")

    def test_healthcheck_timing_is_detected(self):
        self.assert_detected(lambda s: s["identity-service"]["healthcheck"].update(retries=10), "healthcheck ECS")

    def test_healthcheck_on_readiness_is_detected(self):
        self.assert_detected(
            lambda s: s["catalog-service"]["healthcheck"].update(test=["CMD", "node", "-e", "fetch('http://127.0.0.1:3002/health/ready')"]),
            "catalog-service: healthcheck = GET /health",
        )

    def test_extra_variable_is_detected(self):
        self.assert_detected(
            lambda s: s["identity-service"]["environment"].update(IDENTITY_PRIVATE_KEY_PATH="/k"), "variables = task definition"
        )

    def test_missing_variable_is_detected(self):
        self.assert_detected(lambda s: s["audit-service"]["environment"].pop("TRUST_PROXY"), "audit-service: variables")

    def test_kms_emulator_variables_only_allowed_for_identity(self):
        self.assert_detected(
            lambda s: s["catalog-service"]["environment"].update(AWS_ENDPOINT_URL_KMS="http://kms:8080"), "catalog-service: variables"
        )

    def test_insecure_values_are_detected(self):
        for key, bad in (("TRUST_PROXY", "true"), ("COOKIE_SECURE", "false"), ("IDENTITY_JWT_SIGNER", "file")):
            with self.subTest(key=key):
                self.assert_detected(lambda s, k=key, v=bad: s["identity-service"]["environment"].update({k: v}), f"{key}=")

    def test_database_url_without_tls_is_detected(self):
        self.assert_detected(
            lambda s: s["commerce-service"]["environment"].update(COMMERCE_DATABASE_URL=URL.replace("sslmode=require", "sslmode=disable")),
            "COMMERCE_DATABASE_URL",
        )

    def test_ops_task_without_tls_or_with_superuser_is_detected(self):
        self.assert_detected(lambda s: s["postgres-provision"]["environment"].update(PGSSLMODE="disable"), "PGSSLMODE=require")
        self.assert_detected(lambda s: s["postgres-finalize"]["environment"].update(PGUSER="postgres"), "rds_master")
        self.assert_detected(
            lambda s: s["identity-migrate"]["environment"].update(X_DATABASE_URL=URL.replace("sslmode=require", "")), "sslmode=require"
        )

    def test_ops_task_capabilities_are_detected(self):
        self.assert_detected(lambda s: s["catalog-migrate"].update(cap_drop=None), "catalog-migrate: cap_drop=[ALL]")

    def test_database_without_forced_tls_is_detected(self):
        self.assert_detected(lambda s: s["postgres"].update(entrypoint=["sh"]), "hostnossl reject")
        self.assert_detected(lambda s: s["postgres"]["command"].remove("log_statement=none"), "log_statement=none")

    def test_missing_service_is_detected(self):
        self.assert_detected(lambda s: s.pop("audit-service"), "audit-service: presente")


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def quiet(self, fn, *args):
        out, err = io.StringIO(), io.StringIO()
        from contextlib import redirect_stderr

        with redirect_stdout(out), redirect_stderr(err):
            code = fn(*args)
        return code, out.getvalue()

    def seed_output(self, arn, spec="ECC_NIST_P256"):
        path = self.tmp / "seed.out"
        data = {"keyArn": arn, "keySpec": spec, "keyUsage": "SIGN_VERIFY", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----\n"}
        path.write_text("ruido previo\n" + json.dumps(data) + "\n", encoding="utf-8")
        return str(path)

    def test_kms_env_accepts_only_the_emulator_key(self):
        good = "arn:aws:kms:us-east-1:111122223333:key/0b3d1f6e-1234-4abc-9def-0123456789ab"
        code, out = self.quiet(parity.kms_env, self.seed_output(good))
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines()[0], good)
        self.assertIn("BEGIN PUBLIC KEY", out)
        real_account = good.replace("111122223333", "123456789012")
        self.assertEqual(self.quiet(parity.kms_env, self.seed_output(real_account))[0], 1)
        self.assertEqual(self.quiet(parity.kms_env, self.seed_output(good, spec="RSA_2048"))[0], 1)

    def test_redact_removes_every_secret_value(self):
        env = self.tmp / "parity.env"
        env.write_text("POSTGRES_PASSWORD=aaaaaaaaaaaa1111\nSPECTRA_INTERNAL_TOKEN=bbbbbbbbbbbb2222\nPOSTGRES_DB=spectra_parity\n", encoding="utf-8")
        evidence = self.tmp / "ev"
        (evidence / "sub").mkdir(parents=True)
        (evidence / "sub" / "log.txt").write_text("url=postgresql://u:aaaaaaaaaaaa1111@h/spectra_parity token=bbbbbbbbbbbb2222\n", encoding="utf-8")
        code, out = self.quiet(parity.redact, str(env), str(evidence))
        self.assertEqual(code, 0)
        text = (evidence / "sub" / "log.txt").read_text(encoding="utf-8")
        self.assertNotIn("aaaaaaaaaaaa1111", text)
        self.assertNotIn("bbbbbbbbbbbb2222", text)
        self.assertIn("spectra_parity", text)  # los valores no secretos se conservan
        self.assertEqual(json.loads(out)["secret_values_checked"], 2)

    def test_smoke_summary_counts_steps(self):
        steps = [{"step": f"{i}. paso", "result": "PASS"} for i in range(1, 11)] + [{"step": "12. ADMIN", "result": "PASS"}]
        path = self.tmp / "smoke.json"
        path.write_text(json.dumps({"verdict": "PASS", "steps": steps}), encoding="utf-8")
        code, out = self.quiet(parity.smoke_summary, str(path))
        summary = json.loads(out)
        self.assertEqual((code, summary["steps_passed"], summary["base_steps_passed"], summary["admin_steps_passed"]), (0, 11, 10, 1))
        steps[-1] = {"step": "12. ADMIN (M06/M07)", "result": "OMITIDA"}
        path.write_text(json.dumps({"verdict": "PASS", "steps": steps}), encoding="utf-8")
        summary = json.loads(self.quiet(parity.smoke_summary, str(path))[1])
        self.assertEqual((summary["steps_passed"], summary["omitted"]), (10, ["12. ADMIN (M06/M07)"]))

    def test_dt09_summary_requires_zero_failures(self):
        path = self.tmp / "dt09.log"
        path.write_text('{"check":"x","ok":true}\n{"summary":"DT-09","total":492,"passed":492,"failed":0}\n', encoding="utf-8")
        self.assertEqual(self.quiet(parity.dt09_summary, str(path))[0], 0)
        path.write_text('{"summary":"DT-09","total":492,"passed":491,"failed":1}\n', encoding="utf-8")
        self.assertEqual(self.quiet(parity.dt09_summary, str(path))[0], 1)
        path.write_text("sin resumen\n", encoding="utf-8")
        self.assertEqual(self.quiet(parity.dt09_summary, str(path))[0], 1)


if __name__ == "__main__":
    unittest.main()
