#!/usr/bin/env python3
"""Política de seguridad de los workflows de GitHub Actions (PR-5, ampliada en PR-6 / ADR-AWS-06).

Analiza la estructura YAML real (Ruby/Psych, incluido en macOS y en el runner ubuntu-24.04; si no está, falla) y
también el texto. Reglas para TODOS los workflows de .github/workflows:
  W1 acciones de terceros fijadas por SHA completo; imágenes docker:// por digest;
  W2 sin pull_request_target ni workflow_run;
  W3 sin credenciales AWS estáticas (claves, secrets.AWS*, aws-access-key-id…);
  W4 sin operaciones de infraestructura o despliegue: terraform apply/destroy/import/state, ECS (run-task,
     update-service, register-task-definition), migraciones ni llamadas aws fuera de la lista permitida;
  W5 OIDC (id-token: write, aws-actions/*, role-to-assume) solo en el job publish de ecr-publish.yml.
Reglas para ecr-publish.yml:
  E1 solo workflow_dispatch; permisos del workflow {};
  E2 jobs exactamente verify, build-scan y publish, con los permisos exactos de cada uno;
  E3 publish: environment ecr-publish-lab literal, if con refs/heads/main e inputs.publish, needs verify y
     build-scan, role-to-assume desde vars (no secretos);
  E4 checkout siempre con persist-credentials: false;
  E5 sin ${{ inputs.* }} ni ${{ github.event.* }} dentro de run: (inyección de órdenes);
  E6 los scripts que invoca solo usan los comandos aws permitidos.
Uso: verify_workflows.py <raíz_del_repositorio>. Sale con 1 si hay incumplimientos.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PUBLISH_FILE = "ecr-publish.yml"
PUBLISH_ENVIRONMENT = "ecr-publish-lab"
EXPECTED_JOB_PERMISSIONS = {
    "verify": {"contents": "read", "checks": "read", "actions": "read"},
    "build-scan": {"contents": "read"},
    "publish": {"contents": "read", "id-token": "write"},
}
ALLOWED_AWS_COMMANDS = {("ecr", "get-login-password"), ("ecr", "describe-images"), ("sts", "get-caller-identity")}
STATIC_CREDENTIALS = re.compile(
    r"AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|aws-access-key-id|aws-secret-access-key|"
    r"aws-session-token|secrets\.AWS|AKIA[0-9A-Z]{16}")
FORBIDDEN_OPERATIONS = re.compile(
    r"terraform[^\n#]*\s(apply|destroy|import|state|taint)(\s|$)|run-task|update-service|"
    r"register-task-definition|prisma\s+migrate|db-provision|db-finalize|aws\s+ecs\b|aws\s+cloudformation\b")
OIDC_MARKERS = re.compile(r"id-token\s*:\s*write|aws-actions/|role-to-assume")
SHA_PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def load_yaml(path: Path) -> dict:
    ruby = shutil.which("ruby")
    if not ruby:
        raise SystemExit("FAIL no hay Ruby para analizar YAML: la política de workflows no se puede verificar")
    script = ('require "yaml"; require "json"; '
              'd = YAML.safe_load(File.read(ARGV[0]), aliases: false); '
              'd = d.map { |k, v| [k == true ? "on" : k, v] }.to_h if d.is_a?(Hash); puts JSON.generate(d)')
    out = subprocess.run([ruby, "-e", script, str(path)], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"FAIL YAML no válido en {path.name}: {out.stderr.strip()}")
    return json.loads(out.stdout)


def walk(node, path=""):
    """(ruta, clave, valor) de todos los pares del documento."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield path, key, value
            yield from walk(value, f"{path}/{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from walk(value, f"{path}[{i}]")


def aws_commands(text: str) -> set:
    return set(re.findall(r"\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)", text))


def check_all(name: str, text: str, doc: dict) -> None:
    for path, key, value in walk(doc):
        if key == "uses" and isinstance(value, str) and not value.startswith("./"):
            if value.startswith("docker://"):
                if "@sha256:" not in value:
                    fail(f"{name}: imagen sin digest en {path}: {value}")
            elif not SHA_PINNED.match(value):
                fail(f"{name}: acción no fijada por SHA completo en {path}: {value}")
    triggers = doc.get("on")
    trigger_names = set(triggers) if isinstance(triggers, (dict, list)) else {triggers}
    for forbidden in ("pull_request_target", "workflow_run"):
        if forbidden in trigger_names:
            fail(f"{name}: disparador prohibido {forbidden}")
    if STATIC_CREDENTIALS.search(text):
        fail(f"{name}: credenciales AWS estáticas o secretos AWS")
    match = FORBIDDEN_OPERATIONS.search(text)
    if match:
        fail(f"{name}: operación de infraestructura o despliegue prohibida: {match.group(0).strip()!r}")
    extra = aws_commands(text) - ALLOWED_AWS_COMMANDS
    if extra:
        fail(f"{name}: comandos aws no permitidos {sorted(extra)}")
    if name != PUBLISH_FILE and OIDC_MARKERS.search(text):
        fail(f"{name}: OIDC/credenciales AWS solo se admiten en el job publish de {PUBLISH_FILE}")


def check_publish(text: str, doc: dict, root: Path) -> None:
    name = PUBLISH_FILE
    triggers = doc.get("on")
    if not (isinstance(triggers, dict) and set(triggers) == {"workflow_dispatch"}):
        fail(f"{name}: el único disparador permitido es workflow_dispatch (actual: {triggers})")
    if doc.get("permissions") != {}:
        fail(f"{name}: los permisos del workflow deben ser {{}} (actual: {doc.get('permissions')})")
    jobs = doc.get("jobs") or {}
    if set(jobs) != set(EXPECTED_JOB_PERMISSIONS):
        fail(f"{name}: los jobs deben ser exactamente {sorted(EXPECTED_JOB_PERMISSIONS)} (actual: {sorted(jobs)})")
    for job_name, expected in EXPECTED_JOB_PERMISSIONS.items():
        job = jobs.get(job_name) or {}
        if job.get("permissions") != expected:
            fail(f"{name}: permisos de {job_name} deben ser {expected} (actual: {job.get('permissions')})")
        job_text = json.dumps(job)
        if job_name != "publish" and OIDC_MARKERS.search(job_text):
            fail(f"{name}: OIDC fuera del job publish ({job_name})")
        if job_name != "publish" and "environment" in job:
            fail(f"{name}: solo publish puede usar un Environment ({job_name})")
        for path, key, value in walk(job):
            if key == "uses" and isinstance(value, str) and value.startswith("actions/checkout@"):
                step = _step_at(job, path)
                if (step.get("with") or {}).get("persist-credentials") is not False:
                    fail(f"{name}: checkout sin persist-credentials: false en {job_name}")
            if key == "run" and isinstance(value, str) and re.search(r"\$\{\{\s*(inputs\.|github\.event\.)", value):
                fail(f"{name}: {job_name} interpola inputs o github.event dentro de run (usar env)")
        if "secrets." in job_text and job_name != "publish":
            fail(f"{name}: {job_name} no debe usar secretos")
        if "secrets." in job_text and job_name == "publish":
            fail(f"{name}: publish no debe usar secretos (el ARN del rol va en vars)")
    publish = jobs.get("publish") or {}
    if publish.get("environment") != PUBLISH_ENVIRONMENT:
        fail(f"{name}: publish debe usar el Environment literal {PUBLISH_ENVIRONMENT} (actual: {publish.get('environment')})")
    condition = str(publish.get("if", ""))
    if "github.ref == 'refs/heads/main'" not in condition or "inputs.publish" not in condition:
        fail(f"{name}: publish debe exigir github.ref == 'refs/heads/main' e inputs.publish (actual: {condition!r})")
    needs = publish.get("needs")
    needs = set(needs) if isinstance(needs, list) else {needs}
    if not {"verify", "build-scan"} <= needs:
        fail(f"{name}: publish debe depender de verify y build-scan")
    roles = [v for _, k, v in walk(publish) if k == "role-to-assume"]
    if roles != ["${{ vars.AWS_ECR_PUBLISHER_ROLE_ARN }}"]:
        fail(f"{name}: role-to-assume debe ser exactamente ${{{{ vars.AWS_ECR_PUBLISHER_ROLE_ARN }}}} (actual: {roles})")
    if str((jobs.get("verify") or {}).get("if", "")) != "github.ref == 'refs/heads/main'":
        fail(f"{name}: verify debe exigir github.ref == 'refs/heads/main'")
    # E6: los scripts que ejecuta el workflow.
    for script in sorted(set(re.findall(r"scripts/ecr/[A-Za-z0-9_.-]+", text))):
        path = root / script
        if not path.is_file():
            fail(f"{name}: el script {script} no existe")
            continue
        content = path.read_text()
        extra = aws_commands(content) - ALLOWED_AWS_COMMANDS
        if extra:
            fail(f"{script}: comandos aws no permitidos {sorted(extra)}")
        if STATIC_CREDENTIALS.search(content):
            fail(f"{script}: credenciales AWS estáticas")
        match = FORBIDDEN_OPERATIONS.search(content)
        if match:
            fail(f"{script}: operación prohibida {match.group(0).strip()!r}")


def _step_at(job: dict, path: str) -> dict:
    match = re.match(r"/steps\[(\d+)\]", path)
    return (job.get("steps") or [])[int(match.group(1))] if match else {}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    files = sorted((root / ".github" / "workflows").glob("*.y*ml"))
    if not files:
        print("FAIL no hay workflows")
        return 1
    names = [f.name for f in files]
    for path in files:
        text = path.read_text()
        doc = load_yaml(path)
        check_all(path.name, text, doc)
        if path.name == PUBLISH_FILE:
            check_publish(text, doc, root)
    if PUBLISH_FILE not in names:
        fail(f"falta {PUBLISH_FILE}")
    for message in failures:
        print("FAIL", message)
    if failures:
        return 1
    print(f"OK   política de workflows: {', '.join(names)} (OIDC solo en el job publish de {PUBLISH_FILE})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
