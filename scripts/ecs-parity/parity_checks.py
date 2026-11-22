#!/usr/bin/env python3
"""PR-7A: comprobaciones auxiliares de la paridad local con ECS Fargate (solo biblioteca estándar).

Subcomandos:
  check-config <config.json>      valida la configuración renderizada (`docker compose config --format json`)
                                  frente a las task definitions de infra/terraform/modules/ecs. Imprime un
                                  informe JSON SIN valores de variables y sale con 1 si algo no coincide.
  kms-env <salida-kms-seed>       extrae el ARN y la clave pública de la salida de kms-seed (una línea JSON).
  redact <archivo.env> <dir>      sustituye en todos los archivos de <dir> cada valor secreto del archivo de
                                  entorno por «***» y comprueba que no queda ninguno (sale con 1 si queda).
  smoke-summary <smoke.json>      resume el informe del smoke (pasos, veredicto) en una línea JSON.
  dt09-summary <log>              extrae la línea resumen del verificador DT-09.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SERVICES = ("identity-service", "catalog-service", "commerce-service", "audit-service")
JOBS = (
    "postgres-provision",
    "identity-migrate",
    "catalog-migrate",
    "commerce-migrate",
    "audit-migrate",
    "postgres-finalize",
)

EDGE = {"COOKIE_SECURE", "CORS_ORIGINS", "TRUST_PROXY"}
# Variables + secretos de cada task definition (infra/terraform/modules/ecs/workloads.tf).
ECS_ENV = {
    "identity-service": EDGE
    | {
        "PORT",
        "INTERNAL_PORT",
        "IDENTITY_ALLOW_EPHEMERAL_KEYS",
        "IDENTITY_JWT_SIGNER",
        "IDENTITY_KMS_KEY_ID",
        "AWS_REGION",
        "IDENTITY_DATABASE_URL",
        "SPECTRA_INTERNAL_TOKENS",
    },
    "catalog-service": EDGE
    | {
        "PORT",
        "INTERNAL_PORT",
        "IDENTITY_INTERNAL_URL",
        "AUDIT_INTERNAL_URL",
        "IDENTITY_PUBLIC_KEY_PEM",
        "DATABASE_URL",
        "SPECTRA_INTERNAL_TOKENS",
        "SPECTRA_INTERNAL_TOKEN",
        "CATALOG_INVENTORY_TOKENS",
    },
    "commerce-service": EDGE
    | {
        "PORT",
        "IDENTITY_INTERNAL_URL",
        "CATALOG_INTERNAL_URL",
        "IDENTITY_PUBLIC_KEY_PEM",
        "COMMERCE_DATABASE_URL",
        "SPECTRA_INTERNAL_TOKEN",
        "CATALOG_INVENTORY_TOKEN",
    },
    "audit-service": EDGE
    | {
        "PORT",
        "INTERNAL_PORT",
        "IDENTITY_INTERNAL_URL",
        "IDENTITY_PUBLIC_KEY_PEM",
        "AUDIT_DATABASE_URL",
        "SPECTRA_INTERNAL_TOKEN",
        "SPECTRA_INTERNAL_TOKENS",
    },
}
# Únicas diferencias admitidas: el emulador de KMS (en ECS las credenciales vienen del rol de tarea).
LOCAL_ONLY_ENV = {
    "identity-service": {"AWS_ENDPOINT_URL_KMS", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"},
}
EXPECTED_VALUES = {
    "COOKIE_SECURE": "true",
    "TRUST_PROXY": "false",
    "IDENTITY_ALLOW_EPHEMERAL_KEYS": "false",
    "IDENTITY_JWT_SIGNER": "kms",
    "AWS_REGION": "us-east-1",
}
DB_URL_KEYS = {"IDENTITY_DATABASE_URL", "DATABASE_URL", "COMMERCE_DATABASE_URL", "AUDIT_DATABASE_URL"}
ECS_HEALTHCHECK = {("15s", "5s", 3, "30s"), ("15000000000", "5000000000", 3, "30000000000"), (15_000_000_000, 5_000_000_000, 3, 30_000_000_000)}
SECRET_KEY = re.compile(r"(PASSWORD|TOKEN|SECRET)")


def _env(service: dict) -> dict:
    env = service.get("environment") or {}
    if isinstance(env, list):  # forma «CLAVE=valor»
        env = dict(item.split("=", 1) for item in env)
    return env


def check_config(path: str) -> int:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    services = config.get("services", {})
    checks: list[dict] = []

    def record(target: str, check: str, ok: bool, detail: object = None) -> None:
        checks.append({"target": target, "check": check, "ok": bool(ok), "detail": detail})

    for name in SERVICES:
        svc = services.get(name)
        if svc is None:
            record(name, "presente", False)
            continue
        record(name, "read_only=true", svc.get("read_only") is True)
        record(name, "cap_drop=[ALL]", svc.get("cap_drop") == ["ALL"], svc.get("cap_drop"))
        record(name, "sin cap_add", not svc.get("cap_add"))
        record(name, "init=true", svc.get("init") is True)
        record(name, "privileged ausente o false", not svc.get("privileged"))
        record(name, "sin user (usuario de la imagen, como ECS)", "user" not in svc, svc.get("user"))
        record(name, "sin volúmenes", not svc.get("volumes"), [v.get("target") for v in svc.get("volumes") or []])
        record(name, "sin tmpfs (Fargate no lo admite)", not svc.get("tmpfs"))
        record(name, "sin security_opt que relaje el perfil", not svc.get("security_opt"), svc.get("security_opt"))
        record(name, "platform=linux/amd64 (X86_64)", svc.get("platform") == "linux/amd64", svc.get("platform"))
        record(name, "sin build (imagen de la CI)", "build" not in svc)
        record(name, "pull_policy=never", svc.get("pull_policy") == "never")
        hc = svc.get("healthcheck") or {}
        timing = tuple(hc.get(k) for k in ("interval", "timeout", "retries", "start_period"))
        record(name, "healthcheck ECS 15s/5s/3/30s", timing in ECS_HEALTHCHECK, dict(zip(("interval", "timeout", "retries", "start_period"), timing)))
        env = _env(svc)
        probe = " ".join(hc.get("test") or [])
        record(
            name,
            "healthcheck = GET /health en su puerto (como la task definition)",
            f"http://127.0.0.1:{env.get('PORT')}/health'" in probe,
        )
        expected = ECS_ENV[name] | LOCAL_ONLY_ENV.get(name, set())
        keys = set(env)
        record(
            name,
            "variables = task definition (+ solo emulador KMS)",
            keys == expected,
            {"faltan": sorted(expected - keys), "sobran": sorted(keys - expected)},
        )
        for key, value in EXPECTED_VALUES.items():
            if key in env:
                record(name, f"{key}={value}", env[key] == value)
        for key in DB_URL_KEYS & keys:
            url = env[key]
            record(
                name,
                f"{key}: sslmode=require&connection_limit=5",
                "sslmode=require" in url and "connection_limit=5" in url and "@postgres:5432/" in url,
            )

    for name in JOBS:
        svc = services.get(name)
        if svc is None:
            record(name, "presente", False)
            continue
        record(name, "cap_drop=[ALL]", svc.get("cap_drop") == ["ALL"], svc.get("cap_drop"))
        record(name, "init=true", svc.get("init") is True)
        record(name, "read_only=false (como readonlyRootFilesystem=false en ECS)", svc.get("read_only") in (False, None))
        record(name, "platform=linux/amd64", svc.get("platform") == "linux/amd64")
        record(name, "sin build (imagen de la CI)", "build" not in svc)
        env = _env(svc)
        if name.startswith("postgres-"):
            record(name, "PGSSLMODE=require", env.get("PGSSLMODE") == "require")
            record(name, "maestro no superusuario (rds_master)", env.get("PGUSER") == "rds_master")
        else:
            urls = [v for k, v in env.items() if k.endswith("DATABASE_URL")]
            record(name, "URL con sslmode=require", bool(urls) and all("sslmode=require" in u for u in urls))

    pg = services.get("postgres", {})
    command = " ".join(pg.get("command") or [])
    for flag in (
        "ssl=on",
        "ssl_min_protocol_version=TLSv1.2",
        "log_statement=none",
        "log_min_duration_statement=-1",
        "log_min_error_statement=panic",
        "log_connections=on",
        "log_disconnections=on",
        "hba_file=/etc/pgtls/pg_hba.conf",
    ):
        record("postgres", flag, flag in command)
    entry = " ".join(pg.get("entrypoint") or [])
    record("postgres", "hostnossl reject (rds.force_ssl=1)", "hostnossl all all all reject" in entry)

    failed = [c for c in checks if not c["ok"]]
    print(json.dumps({"total": len(checks), "passed": len(checks) - len(failed), "failed": len(failed), "checks": checks}, ensure_ascii=False, indent=1))
    return 0 if not failed else 1


def kms_env(path: str) -> int:
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("{") and '"keyArn"' in line:
            data = json.loads(line)
            if not re.fullmatch(r"arn:aws:kms:us-east-1:111122223333:key/[0-9a-f-]{36}", data["keyArn"]):
                print("ARN inesperado (¿no es el emulador?)", file=sys.stderr)
                return 1
            if data.get("keySpec") != "ECC_NIST_P256" or data.get("keyUsage") != "SIGN_VERIFY":
                print("La clave no es ECC_NIST_P256/SIGN_VERIFY", file=sys.stderr)
                return 1
            print(data["keyArn"])
            print(data["publicKeyPem"], end="")
            return 0
    print("Sin salida JSON de kms-seed", file=sys.stderr)
    return 1


def _secret_values(env_file: str) -> list[str]:
    values = []
    for line in Path(env_file).read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("'\"")
        if SECRET_KEY.search(key) and len(value) >= 8:
            values.append(value)
    return sorted(set(values), key=len, reverse=True)


def redact(env_file: str, directory: str) -> int:
    values = _secret_values(env_file)
    leaks = []
    for root, _dirs, files in os.walk(directory):
        for name in files:
            path = Path(root) / name
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            new = text
            for value in values:
                new = new.replace(value, "***")
            if new != text:
                path.write_text(new, encoding="utf-8")
            if any(value in new for value in values):
                leaks.append(str(path))
    print(json.dumps({"secret_values_checked": len(values), "files_with_leaks_after_redaction": leaks}))
    return 1 if leaks else 0


def smoke_summary(path: str) -> int:
    text = Path(path).read_text(encoding="utf-8")
    start = text.find("{")
    report = json.loads(text[start:]) if start >= 0 else {}
    steps = report.get("steps", [])
    passed = [s for s in steps if s.get("result") == "PASS"]
    base = [s for s in passed if not str(s.get("step", "")).startswith("12.")]
    admin = [s for s in passed if str(s.get("step", "")).startswith("12.")]
    print(
        json.dumps(
            {
                "verdict": report.get("verdict"),
                "steps_total": len(steps),
                "steps_passed": len(passed),
                "base_steps_passed": len(base),
                "admin_steps_passed": len(admin),
                "omitted": [s.get("step") for s in steps if s.get("result") == "OMITIDA"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if report.get("verdict") == "PASS" else 1


def dt09_summary(path: str) -> int:
    for line in reversed(Path(path).read_text(encoding="utf-8").splitlines()):
        line = line.strip()
        if line.startswith("{") and '"summary"' in line:
            data = json.loads(line)
            print(json.dumps(data, ensure_ascii=False))
            return 0 if data.get("failed") == 0 and data.get("total", 0) > 0 else 1
    print('{"error": "sin resumen DT-09"}')
    return 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    command, args = argv[1], argv[2:]
    handlers = {
        "check-config": (check_config, 1),
        "kms-env": (kms_env, 1),
        "redact": (redact, 2),
        "smoke-summary": (smoke_summary, 1),
        "dt09-summary": (dt09_summary, 1),
    }
    if command not in handlers or len(args) != handlers[command][1]:
        print(__doc__, file=sys.stderr)
        return 2
    handler, _ = handlers[command]
    return handler(*args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
