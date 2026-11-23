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
  pg-settings <salida-show>       valida individualmente ssl, versión TLS y los dos parámetros de log.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SERVICES = ("identity-service", "catalog-service", "commerce-service", "audit-service")
JOBS = (
    "postgres-provision",
    "identity-migrate",
    "catalog-migrate",
    "commerce-migrate",
    "audit-migrate",
    "postgres-finalize",
)

# Únicas diferencias admitidas: el emulador de KMS (en ECS las credenciales vienen del rol de tarea).
LOCAL_ONLY_ENV = {
    "identity-service": {"AWS_ENDPOINT_URL_KMS", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"},
}
ECS_HEALTHCHECK = {("15s", "5s", 3, "30s"), ("15000000000", "5000000000", 3, "30000000000"), (15_000_000_000, 5_000_000_000, 3, 30_000_000_000)}
SECRET_KEY = re.compile(r"(PASSWORD|TOKEN|SECRET)")
SERVICE_TF_NAMES = {
    "identity-service": "identity",
    "catalog-service": "catalog",
    "commerce-service": "commerce",
    "audit-service": "audit",
}
SERVICE_SCHEMAS = {name: name.removesuffix("-service") for name in SERVICES}
DB_ROLE_KEYS = {
    "identity-service": "IDENTITY_DATABASE_URL",
    "catalog-service": "DATABASE_URL",
    "commerce-service": "COMMERCE_DATABASE_URL",
    "audit-service": "AUDIT_DATABASE_URL",
}
LOCAL_INTERNAL_URLS = {
    "catalog-service": {"IDENTITY_INTERNAL_URL": "http://identity-service:3101", "AUDIT_INTERNAL_URL": "http://audit-service:3104"},
    "commerce-service": {"IDENTITY_INTERNAL_URL": "http://identity-service:3101", "CATALOG_INTERNAL_URL": "http://catalog-service:3102"},
    "audit-service": {"IDENTITY_INTERNAL_URL": "http://identity-service:3101"},
}
PG_SETTINGS = (
    ("ssl", "on"),
    ("ssl_min_protocol_version", "TLSv1.2"),
    ("log_statement", "none"),
    ("log_min_duration_statement", "-1"),
)


def _object(text: str, assignment: str) -> str:
    """Extrae un objeto HCL por balance de llaves; suficiente para los locals versionados que auditamos."""
    match = re.search(rf"(?m)^\s*{re.escape(assignment)}\s*=\s*\{{", text)
    if not match:
        raise ValueError(f"no se encontró el objeto Terraform {assignment}")
    start = text.find("{", match.start())
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : index]
    raise ValueError(f"objeto Terraform sin cerrar: {assignment}")


def _names(block: str) -> set[str]:
    return set(re.findall(r'(?m)^\s*([A-Z][A-Z0-9_]*)\s*=', block))


def _literals(block: str) -> dict[str, str]:
    return dict(re.findall(r'(?m)^\s*([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"', block))


def _merged_object(block: str, assignment: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(assignment)}\s*=\s*merge\([^,]+,\s*\{{", block)
    if not match:
        raise ValueError(f"no se encontró el objeto merge Terraform {assignment}")
    synthetic = f"{assignment} = " + block[block.rfind("{", match.start(), match.end()) :]
    return _object(synthetic, assignment)


def _variable_default(text: str, name: str) -> str:
    match = re.search(rf'(?m)^\s*variable\s+"{re.escape(name)}"\s*\{{', text)
    if not match:
        raise ValueError(f"no se encontró la variable Terraform {name}")
    synthetic = f"variable_{name} = " + text[text.find("{", match.start()) :]
    block = _object(synthetic, f"variable_{name}")
    match = re.search(r'(?m)^\s*default\s*=\s*"?([^"\s]+)"?\s*$', block)
    if not match:
        raise ValueError(f"variable Terraform sin default literal: {name}")
    return match.group(1)


def terraform_reference(repo: Path) -> dict:
    """Deriva claves y literales auditables del Terraform local, sin plan, provider ni AWS."""
    workloads = (repo / "infra/terraform/modules/ecs/workloads.tf").read_text(encoding="utf-8")
    variables = (repo / "infra/terraform/environments/lab/variables.tf").read_text(encoding="utf-8")
    services = _object(workloads, "services")
    edge = _object(workloads, "edge_environment")
    edge_names = _names(edge)
    edge_literals = _literals(edge)
    env_names = {}
    literal_values = {}
    for compose_name, terraform_name in SERVICE_TF_NAMES.items():
        service = _object(services, terraform_name)
        environment = _merged_object(service, "environment")
        secrets = _object(service, "secrets")
        env_names[compose_name] = edge_names | _names(environment) | _names(secrets)
        literal_values[compose_name] = edge_literals | _literals(environment)
    literal_values["identity-service"]["AWS_REGION"] = _variable_default(variables, "aws_region")
    for name in SERVICES:
        literal_values[name]["TRUST_PROXY"] = _variable_default(variables, "trust_proxy")
    return {
        "env_names": env_names,
        "literal_values": literal_values,
        "cpu_architecture": _variable_default(variables, "cpu_architecture"),
        "connection_limit": _variable_default(variables, "db_connection_limit"),
    }


def _env(service: dict) -> dict:
    env = service.get("environment") or {}
    if isinstance(env, list):  # forma «CLAVE=valor»
        env = dict(item.split("=", 1) for item in env)
    return env


def check_config(path: str) -> int:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    services = config.get("services", {})
    checks: list[dict] = []
    repo = Path(__file__).resolve().parents[2]
    try:
        reference = terraform_reference(repo)
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": f"no se pudo derivar la referencia Terraform: {exc}"}, ensure_ascii=False))
        return 1

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
        expected_platform = {"X86_64": "linux/amd64", "ARM64": "linux/arm64"}.get(reference["cpu_architecture"])
        record(name, f"platform={expected_platform} ({reference['cpu_architecture']} derivado de Terraform)", svc.get("platform") == expected_platform, svc.get("platform"))
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
        expected = reference["env_names"][name] | LOCAL_ONLY_ENV.get(name, set())
        keys = set(env)
        record(
            name,
            "variables = task definition (+ solo emulador KMS)",
            keys == expected,
            {"faltan": sorted(expected - keys), "sobran": sorted(keys - expected)},
        )
        for key, value in reference["literal_values"][name].items():
            record(name, f"{key}={value} (derivado de Terraform)", env.get(key) == value)
        record(
            name,
            "CORS_ORIGINS local: mismo origen HTTPS (parcial; Terraform lo obtiene de CloudFront)",
            bool(env.get("CORS_ORIGINS")) and str(env["CORS_ORIGINS"]).startswith("https://"),
        )
        for key, value in LOCAL_INTERNAL_URLS.get(name, {}).items():
            record(
                name,
                f"{key}: equivalencia Cloud Map → nombre Compose (control seleccionado)",
                env.get(key) == value,
            )
        db_key = DB_ROLE_KEYS[name]
        parsed = urlparse(str(env.get(db_key, "")))
        query = parse_qs(parsed.query)
        schema = SERVICE_SCHEMAS[name]
        record(
            name,
            f"{db_key}: rol, esquema y TLS derivados de Terraform",
            parsed.scheme == "postgresql"
            and parsed.hostname == "postgres"
            and parsed.port == 5432
            and parsed.username == f"spectra_{schema}_app"
            and query.get("schema") == [schema]
            and query.get("sslmode") == ["require"]
            and query.get("connection_limit") == [reference["connection_limit"]],
        )

    cors = {_env(services.get(name, {})).get("CORS_ORIGINS") for name in SERVICES}
    record("servicios", "CORS_ORIGINS idéntico en los 4 servicios", len(cors) == 1 and None not in cors)
    identity_env = _env(services.get("identity-service", {}))
    record(
        "identity-service",
        "IDENTITY_KMS_KEY_ID = ARN del emulador local (parcial; ARN AWS solo se conoce al desplegar)",
        bool(re.fullmatch(r"arn:aws:kms:us-east-1:111122223333:key/[0-9a-f-]{36}", str(identity_env.get("IDENTITY_KMS_KEY_ID", "")))),
    )
    for name in ("catalog-service", "commerce-service", "audit-service"):
        pem = str(_env(services.get(name, {})).get("IDENTITY_PUBLIC_KEY_PEM", ""))
        record(
            name,
            "IDENTITY_PUBLIC_KEY_PEM con formato PEM (parcial; valor AWS solo se conoce al desplegar)",
            pem.startswith("-----BEGIN PUBLIC KEY-----") and pem.rstrip().endswith("-----END PUBLIC KEY-----"),
        )
    token_env = {name: _env(services.get(name, {})) for name in SERVICES}
    internal_tokens = [
        token_env["identity-service"].get("SPECTRA_INTERNAL_TOKENS"),
        token_env["catalog-service"].get("SPECTRA_INTERNAL_TOKENS"),
        token_env["catalog-service"].get("SPECTRA_INTERNAL_TOKEN"),
        token_env["commerce-service"].get("SPECTRA_INTERNAL_TOKEN"),
        token_env["audit-service"].get("SPECTRA_INTERNAL_TOKEN"),
        token_env["audit-service"].get("SPECTRA_INTERNAL_TOKENS"),
    ]
    inventory_tokens = [
        token_env["catalog-service"].get("CATALOG_INVENTORY_TOKENS"),
        token_env["commerce-service"].get("CATALOG_INVENTORY_TOKEN"),
    ]
    record("servicios", "token interno coherente y no vacío (valor efímero, no se registra)", bool(internal_tokens[0]) and len(set(internal_tokens)) == 1)
    record(
        "servicios",
        "token de inventario coherente, no vacío y distinto del interno (valor efímero)",
        bool(inventory_tokens[0]) and len(set(inventory_tokens)) == 1 and inventory_tokens[0] != internal_tokens[0],
    )

    for name in JOBS:
        svc = services.get(name)
        if svc is None:
            record(name, "presente", False)
            continue
        record(name, "cap_drop=[ALL]", svc.get("cap_drop") == ["ALL"], svc.get("cap_drop"))
        record(name, "init=true", svc.get("init") is True)
        record(name, "read_only=false (como readonlyRootFilesystem=false en ECS)", svc.get("read_only") in (False, None))
        expected_platform = {"X86_64": "linux/amd64", "ARM64": "linux/arm64"}.get(reference["cpu_architecture"])
        record(name, f"platform={expected_platform} (derivado de Terraform)", svc.get("platform") == expected_platform)
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


def pg_settings(path: str) -> int:
    """Valida cada valor devuelto por los cuatro SHOW de PostgreSQL usados por P-06b."""
    values = [line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    checks = []
    for index, (name, expected) in enumerate(PG_SETTINGS):
        actual = values[index] if index < len(values) else None
        checks.append({"name": name, "expected": expected, "actual": actual, "ok": actual == expected})
    failed = [check for check in checks if not check["ok"]]
    print(json.dumps({"total": len(checks), "passed": len(checks) - len(failed), "failed": len(failed), "checks": checks}, ensure_ascii=False))
    return 1 if failed else 0


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
        "pg-settings": (pg_settings, 1),
    }
    if command not in handlers or len(args) != handlers[command][1]:
        print(__doc__, file=sys.stderr)
        return 2
    handler, _ = handlers[command]
    return handler(*args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
