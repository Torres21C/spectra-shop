#!/usr/bin/env python3
"""Propiedad de los recursos entre las raíces de Terraform de SPECTRA Shop (PR-6.2, ADR-AWS-06 D-AWS-06-18).

Analiza el código (sin Terraform, sin red ni AWS) siguiendo las llamadas a módulos locales de cada raíz y falla
(código 1) si:
  - una raíz declara un tipo de recurso fuera de su lista permitida (publisher y bootstrap): así publisher no
    puede crear ECS, RDS, ALB, VPC, CloudFront, WAF, Secrets Manager ni nada más que ECR y el rol OIDC;
  - un tipo de recurso exclusivo (ECR, proveedor OIDC, CloudTrail) o un módulo exclusivo (registry,
    github_oidc_publisher) aparece en una raíz que no es su propietaria: ningún recurso en dos states;
  - alguna raíz lee el state de otra (data "terraform_remote_state");
  - lab vuelve a declarar las variables del publicador (podría habilitarse desde lab) o deja de leer los
    repositorios con data "aws_ecr_repository";
  - publisher y lab no declaran los mismos 5 repositorios, o publisher usa una CMK para ECR (D2);
  - falta prevent_destroy en el bucket y la clave del state o en el bucket de auditoría;
  - el bootstrap no garantiza el orden de D7 (presupuesto → clave KMS → buckets → resto): todo recurso debe
    depender del presupuesto, y todo recurso salvo el presupuesto y la clave debe depender de la clave; los
    tres depends_on directos deben existir y las dependencias no pueden formar ciclos.

Uso: python3 -I scripts/check_state_ownership.py [directorio infra/terraform]
Compatible con Python 3.9; solo biblioteca estándar.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOTS = {"bootstrap": "bootstrap", "publisher": "publisher", "lab": "environments/lab"}

ALLOWED = {
    "publisher": {
        "aws_ecr_repository", "aws_ecr_lifecycle_policy",
        "aws_iam_openid_connect_provider", "aws_iam_role", "aws_iam_role_policy",
    },
    "bootstrap": {
        "aws_kms_key", "aws_kms_alias", "aws_s3_bucket", "aws_s3_bucket_public_access_block",
        "aws_s3_bucket_ownership_controls", "aws_s3_bucket_versioning",
        "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_lifecycle_configuration",
        "aws_s3_bucket_policy", "aws_cloudtrail", "aws_budgets_budget",
    },
}

# Tipo o módulo → única raíz que puede administrarlo.
EXCLUSIVE_TYPES = {
    "aws_ecr_repository": "publisher",
    "aws_ecr_lifecycle_policy": "publisher",
    "aws_ecr_repository_policy": "publisher",
    "aws_iam_openid_connect_provider": "publisher",
    "aws_cloudtrail": "bootstrap",
}
EXCLUSIVE_MODULES = {"modules/registry": "publisher", "modules/github_oidc_publisher": "publisher"}

# Variables que no pueden volver a lab (con ellas se podría habilitar el publicador desde lab).
LAB_FORBIDDEN_VARIABLES = {
    "enable_ecr_publisher", "create_github_oidc_provider", "github_oidc_provider_arn",
    "github_oidc_subject_prefix", "github_publish_environment", "ecr_force_delete", "ecr_keep_images",
}

PREVENT_DESTROY = [("bootstrap", "aws_kms_key", "state"), ("bootstrap", "aws_s3_bucket", "state"),
                   ("bootstrap", "aws_s3_bucket", "audit")]

# D7: orden de creación del bootstrap. Cada par exige un depends_on directo en el recurso.
BUDGET, STATE_KEY = "aws_budgets_budget.account", "aws_kms_key.state"
ORDER_DEPENDS_ON = [(STATE_KEY, BUDGET), ("aws_s3_bucket.state", STATE_KEY), ("aws_s3_bucket.audit", STATE_KEY)]

BLOCK_RE = re.compile(r'^[ \t]*(resource|data|module|variable)[ \t]+"([^"]+)"(?:[ \t]+"([^"]+)")?[ \t]*\{', re.M)


def strip_comments(text: str) -> str:
    """Elimina comentarios #, // y /* */ fuera de cadenas, conservando los saltos de línea."""
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif c == "#" or text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            out.append("\n" * text.count("\n", i, end))
            i = end
        else:
            out.append(c)
            i += 1
    return "".join(out)


def block_body(text: str, start: int) -> str:
    """Cuerpo entre la llave que abre en `start - 1` y su llave de cierre (texto ya sin comentarios)."""
    depth, i, in_str = 1, start, False
    while i < len(text) and depth:
        c = text[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return text[start:i - 1]


def parse_dir(path: Path) -> list[dict]:
    blocks = []
    for tf in sorted(path.glob("*.tf")):
        text = strip_comments(tf.read_text())
        for m in BLOCK_RE.finditer(text):
            kind, a, b = m.groups()
            blocks.append({"kind": kind, "type": a, "name": b if kind in ("resource", "data") else a,
                           "body": block_body(text, m.end()), "file": tf})
    return blocks


def module_source(body: str) -> str | None:
    m = re.search(r'^\s*source\s*=\s*"([^"]+)"', body, re.M)
    return m.group(1) if m else None


def collect(tf_root: Path, rel_dir: str) -> dict:
    """Recursos, data sources y módulos locales alcanzables desde una raíz."""
    found = {"resources": [], "data": [], "modules": [], "variables": [], "blocks": []}

    def walk(directory: Path, address: str, depth: int) -> None:
        if depth > 10:
            raise RuntimeError(f"anidamiento de módulos demasiado profundo en {directory}")
        for blk in parse_dir(directory):
            if blk["kind"] == "resource":
                found["resources"].append((blk["type"], f"{address}{blk['type']}.{blk['name']}", blk))
            elif blk["kind"] == "data":
                found["data"].append((blk["type"], f"{address}data.{blk['type']}.{blk['name']}"))
            elif blk["kind"] == "variable" and depth == 0:
                found["variables"].append(blk["name"])
            elif blk["kind"] == "module":
                src = module_source(blk["body"])
                if src and src.startswith("."):
                    target = (directory / src).resolve()
                    found["modules"].append((target.relative_to(tf_root.resolve()).as_posix(), blk["name"], blk))
                    walk(target, f"{address}module.{blk['name']}.", depth + 1)
            found["blocks"].append(blk)

    walk(tf_root / rel_dir, "", 0)
    return found


def references_only(body: str) -> str:
    """Sustituye cada cadena por sus interpolaciones: un nombre de recurso dentro de un texto no es dependencia."""
    return re.sub(r'"((?:[^"\\]|\\.)*)"', lambda m: " ".join(re.findall(r'\$\{([^}]*)\}', m.group(1))), body)


def explicit_depends_on(body: str) -> set[str]:
    m = re.search(r'^[ \t]*depends_on[ \t]*=[ \t]*\[([^\]]*)\]', body, re.M)
    return {ref.strip() for ref in m.group(1).split(",") if ref.strip()} if m else set()


def dependency_graph(blocks: list[dict]) -> dict[str, set[str]]:
    """Dependencias directas (referencias y depends_on) entre los recursos y data sources de una raíz sin módulos.

    Las dependencias que pasan por un `local` no se cuentan: la comprobación solo puede ser más estricta que
    Terraform. Los ciclos que pasan por un `local` los detecta `terraform validate`.
    """
    nodes = {("data." if b["kind"] == "data" else "") + f"{b['type']}.{b['name']}": references_only(b["body"])
             for b in blocks if b["kind"] in ("resource", "data")}
    return {address: {other for other in nodes
                      if re.search(r'(?<![\w.-])' + re.escape(other) + r'(?![\w-])', body)}
            for address, body in nodes.items()}


def reachable(graph: dict[str, set[str]], start: str) -> set[str]:
    seen, pending = set(), list(graph.get(start, ()))
    while pending:
        node = pending.pop()
        if node not in seen:
            seen.add(node)
            pending.extend(graph.get(node, ()))
    return seen


def repositories(blocks: list[dict]) -> list[str] | None:
    for blk in blocks:
        if blk["file"].name == "main.tf":
            m = re.search(r'^\s*repositories\s*=\s*\[([^\]]*)\]', strip_comments(blk["file"].read_text()), re.M)
            if m:
                return re.findall(r'"([^"]+)"', m.group(1))
    return None


def check_bootstrap_order(bootstrap: dict) -> list[str]:
    """D7: presupuesto → clave KMS → buckets → resto, garantizado por las dependencias del código."""
    errors = []
    graph = dependency_graph(bootstrap["blocks"])
    bodies = {address: blk["body"] for _, address, blk in bootstrap["resources"]}
    for address, required in ORDER_DEPENDS_ON:
        if required not in explicit_depends_on(bodies.get(address, "")):
            errors.append(f"bootstrap: D7: {address} debe declarar depends_on = [{required}]")
    if re.search(r'^ {0,2}(count|for_each)\s*=', bodies.get(BUDGET, ""), re.M):
        errors.append(f"bootstrap: D7: {BUDGET} no puede ser condicional (count o for_each)")
    for address in sorted(graph):
        if address in reachable(graph, address):
            errors.append(f"bootstrap: D7: {address} forma parte de un ciclo de dependencias")
    for address in sorted(bodies):
        dependencies = reachable(graph, address)
        if address != BUDGET and BUDGET not in dependencies:
            errors.append(f"bootstrap: D7: {address} podría crearse antes que el presupuesto ({BUDGET})")
        if address not in (BUDGET, STATE_KEY) and STATE_KEY not in dependencies:
            errors.append(f"bootstrap: D7: {address} podría crearse antes que la clave ({STATE_KEY})")
    return errors


def analyze(tf_root: Path) -> tuple[list[str], dict]:
    errors: list[str] = []
    roots = {name: collect(tf_root, rel) for name, rel in ROOTS.items()}

    for name, allowed in ALLOWED.items():
        for rtype, address, _ in roots[name]["resources"]:
            if rtype not in allowed:
                errors.append(f"{name}: recurso no permitido en esta raíz: {address} ({rtype})")

    for name, data in roots.items():
        for rtype, address, _ in data["resources"]:
            owner = EXCLUSIVE_TYPES.get(rtype)
            if owner and owner != name:
                errors.append(f"{name}: {address} ({rtype}) solo puede administrarlo la raíz {owner}")
        for module_dir, module_name, _ in data["modules"]:
            owner = EXCLUSIVE_MODULES.get(module_dir)
            if owner and owner != name:
                errors.append(f"{name}: el módulo {module_name} ({module_dir}) solo puede usarlo la raíz {owner}")
        for dtype, address in data["data"]:
            if dtype == "terraform_remote_state":
                errors.append(f"{name}: {address}: ninguna raíz lee el state de otra (terraform_remote_state)")

    lab = roots["lab"]
    for var in sorted(LAB_FORBIDDEN_VARIABLES & set(lab["variables"])):
        errors.append(f"lab: la variable {var} pertenece a infra/terraform/publisher")
    if not any(dtype == "aws_ecr_repository" for dtype, _ in lab["data"]):
        errors.append('lab: debe leer los repositorios con data "aws_ecr_repository" (no crearlos)')

    lab_main = (tf_root / "environments/lab/main.tf").read_text()
    lab_provider = (tf_root / "environments/lab/providers.tf").read_text()
    lab_backend = (tf_root / "environments/lab/backend.hcl.example").read_text()
    if not re.search(r'secret_prefix\s*=\s*"spectra/\$\{var\.environment\}/\$\{var\.lab_cycle_id\}"', lab_main):
        errors.append("lab: los secretos deben incluir var.lab_cycle_id sin cambiar environment")
    if not re.search(r'LabCycle\s*=\s*var\.lab_cycle_id', lab_provider):
        errors.append("lab: default_tags debe registrar LabCycle = var.lab_cycle_id")
    if not re.search(r'skip_final_snapshot\s*=\s*true', lab_main):
        errors.append("lab: synthetic-discard debe omitir incondicionalmente el snapshot final")
    if re.search(r'final_snapshot_identifier\s*=\s*"', lab_main):
        errors.append("lab: no puede declarar un identificador fijo de snapshot final")
    if not re.search(r'key\s*=\s*"spectra-shop/lab/terraform\.tfstate"', lab_backend):
        errors.append("lab: lab_cycle_id no puede cambiar la clave estable del backend")

    pub_repos, lab_repos = repositories(roots["publisher"]["blocks"]), repositories(lab["blocks"])
    if not pub_repos or len(pub_repos) != 5 or sorted(pub_repos) != sorted(lab_repos or []):
        errors.append(f"publisher y lab deben declarar los mismos 5 repositorios: {pub_repos} / {lab_repos}")

    for module_dir, module_name, blk in roots["publisher"]["modules"]:
        if module_dir == "modules/registry" and re.search(r'^\s*kms_key_arn\s*=', blk["body"], re.M):
            errors.append("publisher: D2 usa la clave administrada por AWS aws/ecr; no se pasa kms_key_arn a registry")

    for root, rtype, rname in PREVENT_DESTROY:
        matches = [blk for t, _, blk in roots[root]["resources"] if t == rtype and blk["name"] == rname]
        if not matches or not re.search(r'prevent_destroy\s*=\s*true', matches[0]["body"]):
            errors.append(f"{root}: {rtype}.{rname} debe tener lifecycle {{ prevent_destroy = true }}")

    errors += check_bootstrap_order(roots["bootstrap"])

    summary = {name: sorted({t for t, _, _ in data["resources"]}) for name, data in roots.items()}
    counts = {name: len(data["resources"]) for name, data in roots.items()}
    return errors, {"types": summary, "blocks": counts}


def main(argv: list[str]) -> int:
    tf_root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    errors, info = analyze(tf_root)
    for name in ROOTS:
        print(f"     {name}: {info['blocks'][name]} bloques resource, {len(info['types'][name])} tipos")
    if errors:
        for e in errors:
            print("FAIL", e)
        return 1
    print("OK   propiedad de los recursos: publisher solo ECR y rol OIDC; ningún recurso en dos states; "
          "sin terraform_remote_state; prevent_destroy en el state y su auditoría; "
          "orden de D7 en el bootstrap (presupuesto → clave → buckets → resto)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
