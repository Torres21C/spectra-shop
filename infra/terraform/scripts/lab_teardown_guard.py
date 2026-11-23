#!/usr/bin/env python3
"""Guard de solo lectura para todo plan de environments/lab: despliegue, preparación del apagado y destrucción.

Valida seis artefactos creados y revisados por el operador:
  - metadata local del backend inicializado (.terraform/terraform.tfstate) y workspace activo;
  - identidad aprobada del ciclo (lineage, serial mínimo, backend, workspace y lab_cycle_id);
  - state remoto obtenido con `terraform state pull` bajo autorización (vacío solo en el primer despliegue);
  - plan binario guardado (`terraform plan -out`) y su SHA-256 aprobado;
  - JSON de ese plan obtenido con `terraform show -json`.

El plan binario es un ZIP: `tfplan` (protobuf) y `tfstate` (state previo con lineage y serial). El guard lo
lee con la biblioteca estándar, sin ejecutar Terraform, y lo vincula con el JSON y con el state aprobado. El
formato se verificó con Terraform 1.17.2 (versión fijada en la CI); con otra versión el guard falla cerrado.

Modos:
  deploy   primer despliegue (state vacío) o actualización del mismo ciclo; rechaza cambiar lab_cycle_id
           sobre un state activo, planes parciales y la eliminación de RDS, secretos o claves KMS.
  prepare  preparación del apagado: solo la allowlist de atributos de protección y ECS a cero.
  destroy  destrucción completa del state aprobado, ya preparado.

No ejecuta Terraform, AWS ni comandos externos y nunca modifica archivos.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import zipfile
from pathlib import Path
from typing import Any

EXPECTED_BACKEND_TYPE = "s3"
EXPECTED_BACKEND_KEY = "spectra-shop/lab/terraform.tfstate"
EXPECTED_REGION = "us-east-1"
EXPECTED_WORKSPACE = "default"
# Versión de Terraform fijada en .github/workflows/iac.yml y formato de plan comprobado con ella.
EXPECTED_TERRAFORM_VERSION = "1.17.2"
EXPECTED_PLAN_FORMAT = 3
MAX_PLAN_MEMBER_BYTES = 64 * 1024 * 1024
CYCLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

ALLOWED_MODULES = {
    "module.kms",
    "module.network",
    "module.security_groups",
    "module.endpoints",
    "module.database",
    "module.secrets",
    "module.alb",
    "module.observability",
    "module.edge",
    "module.ecs",
}
FORBIDDEN_TYPES = {
    "aws_ecr_repository",
    "aws_ecr_lifecycle_policy",
    "aws_iam_openid_connect_provider",
    "aws_cloudtrail",
}
FORBIDDEN_ADDRESSES = {
    "aws_kms_key.state",
    "aws_s3_bucket.state",
    "aws_s3_bucket.audit",
    "aws_budgets_budget.account",
}

RDS = "module.database.aws_db_instance.this"
SPA = "module.edge.aws_s3_bucket.spa"
ALB = "module.alb.aws_lb.this"
ECS_RE = re.compile(r'^module\.ecs\.aws_ecs_service\.this\["(identity|catalog|commerce|audit)"\]$')
# Recursos con datos o material criptográfico del ciclo: un plan normal no puede eliminarlos ni reemplazarlos.
# Su eliminación solo se admite en el modo destroy, después de la preparación validada.
STATEFUL_RE = re.compile(
    r"^(module\.database\.aws_db_instance\.this"
    r"|module\.secrets\.aws_secretsmanager_secret\.[a-z_]+(\[[^\]]+\])?"
    r"|module\.kms\.aws_kms_key\.[a-z_]+(\[[^\]]+\])?)$"
)
DATA_ADDRESS_RE = re.compile(r'^(module\.[A-Za-z0-9_-]+(\[[^\]]*\])?\.)*data\.')
ALLOWED_PATHS = {
    RDS: {"deletion_protection"},
    SPA: {"force_destroy"},
    # teardown.tfvars fija alb_deletion_protection=false; solo cambia si el ciclo la había activado.
    ALB: {"enable_deletion_protection"},
}
# Valor final exigido en preparación y valor previo exigido en destroy (destroy no debe fallar a medias).
REQUIRED_FINAL = {
    RDS: ("deletion_protection", False),
    SPA: ("force_destroy", True),
    ALB: ("enable_deletion_protection", False),
}


class GuardError(ValueError):
    pass


# ---------------------------------------------------------------------------------------------------------
# Lectura de artefactos
# ---------------------------------------------------------------------------------------------------------


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"{path}: JSON ilegible: {exc}") from exc
    if not isinstance(data, dict):
        raise GuardError(f"{path}: la raíz debe ser un objeto JSON")
    return data


def load_state(path: Path) -> dict[str, Any] | None:
    """`terraform state pull` no imprime nada si el backend aún no tiene state: eso es un state ausente."""
    try:
        text = path.read_text()
    except OSError as exc:
        raise GuardError(f"{path}: state ilegible: {exc}") from exc
    if not text.strip():
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GuardError(f"{path}: state ilegible: {exc}") from exc
    if not isinstance(data, dict):
        raise GuardError(f"{path}: el state debe ser un objeto JSON")
    return data


def workspace(path: Path) -> str:
    if not path.exists():
        return EXPECTED_WORKSPACE
    value = path.read_text().strip()
    return value or EXPECTED_WORKSPACE


# --- protobuf (solo el subconjunto del formato de cable que usa tfplan) ----------------------------------


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if i >= len(buf) or shift > 63:
            raise GuardError("plan binario: varint truncado")
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def pb_fields(buf: bytes) -> list[tuple[int, int, Any]]:
    fields, i = [], 0
    while i < len(buf):
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            size, i = _varint(buf, i)
            value, i = buf[i : i + size], i + size
        elif wire == 1:
            value, i = buf[i : i + 8], i + 8
        elif wire == 5:
            value, i = buf[i : i + 4], i + 4
        else:
            raise GuardError(f"plan binario: tipo de campo protobuf no soportado ({wire})")
        if i > len(buf):
            raise GuardError("plan binario: campo truncado")
        fields.append((number, wire, value))
    return fields


def _text(value: Any, label: str) -> str:
    if not isinstance(value, bytes):
        raise GuardError(f"plan binario: {label} inválido")
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GuardError(f"plan binario: {label} no es UTF-8") from exc


def _first(fields: list[tuple[int, int, Any]], number: int) -> Any:
    for field, _, value in fields:
        if field == number:
            return value
    return None


# --- msgpack (codificación de cty en DynamicValue) -------------------------------------------------------


def _mp(buf: bytes, i: int) -> tuple[Any, int]:
    if i >= len(buf):
        raise GuardError("plan binario: msgpack truncado")
    b = buf[i]
    i += 1

    def take(n: int) -> bytes:
        nonlocal i
        if i + n > len(buf):
            raise GuardError("plan binario: msgpack truncado")
        out = buf[i : i + n]
        i += n
        return out

    def seq(n: int) -> list[Any]:
        nonlocal i
        items = []
        for _ in range(n):
            item, i = _mp(buf, i)
            items.append(item)
        return items

    def mapping(n: int) -> dict[Any, Any]:
        nonlocal i
        out: dict[Any, Any] = {}
        for _ in range(n):
            key, i = _mp(buf, i)
            if not isinstance(key, str):
                raise GuardError("plan binario: clave msgpack no textual")
            out[key], i = _mp(buf, i)
        return out

    def string(n: int) -> str:
        try:
            return take(n).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise GuardError("plan binario: cadena msgpack no UTF-8") from exc

    if b <= 0x7F:
        return b, i
    if 0x80 <= b <= 0x8F:
        return mapping(b & 0x0F), i
    if 0x90 <= b <= 0x9F:
        return seq(b & 0x0F), i
    if 0xA0 <= b <= 0xBF:
        return string(b & 0x1F), i
    if b >= 0xE0:
        return b - 0x100, i
    simple = {0xC0: None, 0xC2: False, 0xC3: True}
    if b in simple:
        return simple[b], i
    sizes = {0xC4: 1, 0xC5: 2, 0xC6: 4}
    if b in sizes:
        return take(int.from_bytes(take(sizes[b]), "big")), i
    if b == 0xCA:
        return struct.unpack(">f", take(4))[0], i
    if b == 0xCB:
        return struct.unpack(">d", take(8))[0], i
    unsigned = {0xCC: 1, 0xCD: 2, 0xCE: 4, 0xCF: 8}
    if b in unsigned:
        return int.from_bytes(take(unsigned[b]), "big"), i
    signed = {0xD0: 1, 0xD1: 2, 0xD2: 4, 0xD3: 8}
    if b in signed:
        return int.from_bytes(take(signed[b]), "big", signed=True), i
    strings = {0xD9: 1, 0xDA: 2, 0xDB: 4}
    if b in strings:
        return string(int.from_bytes(take(strings[b]), "big")), i
    if b in (0xDC, 0xDD):
        return seq(int.from_bytes(take(2 if b == 0xDC else 4), "big")), i
    if b in (0xDE, 0xDF):
        return mapping(int.from_bytes(take(2 if b == 0xDE else 4), "big")), i
    # Extensiones (cty las usa para valores desconocidos) y códigos reservados: no verificables.
    raise GuardError(f"plan binario: valor msgpack no verificable (0x{b:02x})")


def msgpack(buf: bytes) -> Any:
    value, i = _mp(buf, 0)
    if i != len(buf):
        raise GuardError("plan binario: msgpack con bytes sobrantes")
    return value


def dynamic_value(buf: Any, wrapped: bool) -> Any:
    """DynamicValue{1: msgpack}. Las variables llevan el tipo dinámico de cty: [tipo JSON, valor]."""
    if not isinstance(buf, bytes):
        raise GuardError("plan binario: DynamicValue inválido")
    raw = _first(pb_fields(buf), 1)
    if not isinstance(raw, bytes):
        raise GuardError("plan binario: DynamicValue sin msgpack")
    value = msgpack(raw)
    if wrapped:
        if not (isinstance(value, list) and len(value) == 2 and isinstance(value[0], bytes)):
            raise GuardError("plan binario: variable sin tipo dinámico de cty")
        return value[1]
    return value


def read_plan_file(path: Path) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(path) as archive:
            members = {info.filename: info for info in archive.infolist()}
            for name in ("tfplan", "tfstate"):
                if name not in members:
                    raise GuardError(f"plan binario: falta {name}")
                if members[name].file_size > MAX_PLAN_MEMBER_BYTES:
                    raise GuardError(f"plan binario: {name} excede el tamaño admitido")
            raw = archive.read("tfplan")
            prior = archive.read("tfstate")
    except (OSError, zipfile.BadZipFile) as exc:
        raise GuardError(f"{path}: plan binario ilegible: {exc}") from exc

    fields = pb_fields(raw)
    plan: dict[str, Any] = {
        "format": _first(fields, 1),
        "variables": {},
        "changes": set(),
        "outputs": set(),
        "targets": [],
        "backend": None,
        "terraform_version": None,
        "destroy": False,
        "complete": False,
    }
    for number, wire, value in fields:
        if number == 2 and wire == 2:
            entry = pb_fields(value)
            name = _text(_first(entry, 1), "nombre de variable")
            if name in plan["variables"]:
                raise GuardError(f"plan binario: variable duplicada {name}")
            plan["variables"][name] = dynamic_value(_first(entry, 2), wrapped=True)
        elif number == 3 and wire == 2:
            plan["changes"].add(_text(_first(pb_fields(value), 13), "dirección de recurso"))
        elif number == 4 and wire == 2:
            plan["outputs"].add(_text(_first(pb_fields(value), 1), "nombre de output"))
        elif number == 5 and wire == 2:
            plan["targets"].append(_text(value, "target"))
        elif number == 13 and wire == 2:
            backend = pb_fields(value)
            plan["backend"] = {
                "type": _text(_first(backend, 1), "tipo de backend"),
                "config": dynamic_value(_first(backend, 2), wrapped=False),
                "workspace": _text(_first(backend, 3), "workspace"),
            }
        elif number == 14 and wire == 2:
            plan["terraform_version"] = _text(value, "versión de Terraform")
        elif number == 17 and wire == 0:
            plan["destroy"] = value == 1
        elif number == 26 and wire == 0:
            plan["complete"] = value == 1
    try:
        plan["prior_state"] = json.loads(prior)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise GuardError("plan binario: tfstate embebido ilegible") from exc
    if not isinstance(plan["prior_state"], dict):
        raise GuardError("plan binario: tfstate embebido inválido")
    return plan


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
    except OSError as exc:
        raise GuardError(f"{path}: plan binario ilegible: {exc}") from exc
    return digest.hexdigest()


# ---------------------------------------------------------------------------------------------------------
# Backend, identidad y state
# ---------------------------------------------------------------------------------------------------------


def backend_config(metadata: dict[str, Any]) -> dict[str, Any]:
    backend = metadata.get("backend")
    if not isinstance(backend, dict) or backend.get("type") != EXPECTED_BACKEND_TYPE:
        raise GuardError("backend inicializado: se esperaba type=s3")
    config = backend.get("config")
    if not isinstance(config, dict):
        raise GuardError("backend inicializado: falta config")
    return config


def exact_backend(config: dict[str, Any], expected: dict[str, Any], label: str = "backend inicializado") -> None:
    if expected.get("key") != EXPECTED_BACKEND_KEY or expected.get("region") != EXPECTED_REGION:
        raise GuardError("identidad aprobada: key o región no corresponden a environments/lab")
    required = {
        "bucket": expected.get("bucket"),
        "key": EXPECTED_BACKEND_KEY,
        "region": EXPECTED_REGION,
        "kms_key_id": expected.get("kms_key_id"),
    }
    for name, value in required.items():
        if not isinstance(value, str) or not value:
            raise GuardError(f"identidad aprobada: backend.{name} vacío")
        if config.get(name) != value:
            raise GuardError(f"{label}: {name}={config.get(name)!r}; esperado {value!r}")
    if config.get("workspace_key_prefix", "env:") not in (None, "", "env:"):
        raise GuardError(f"{label}: workspace_key_prefix no autorizado")


def validate_identity(identity: dict[str, Any]) -> None:
    if identity.get("workspace") != EXPECTED_WORKSPACE:
        raise GuardError("identidad aprobada: workspace debe ser default")
    if not isinstance(identity.get("backend"), dict):
        raise GuardError("identidad aprobada: falta backend")
    cycle = identity.get("lab_cycle_id")
    if not isinstance(cycle, str) or not CYCLE_RE.fullmatch(cycle):
        raise GuardError("identidad aprobada: lab_cycle_id ausente o inválido")
    serial = identity.get("minimum_serial")
    if isinstance(serial, bool) or not isinstance(serial, int) or serial < 0:
        raise GuardError("identidad aprobada: minimum_serial ausente o inválido")
    lineage = identity.get("lineage")
    if lineage is not None and (not isinstance(lineage, str) or not lineage):
        raise GuardError("identidad aprobada: lineage inválido")


def resource_address(resource: dict[str, Any]) -> str:
    base = f"{resource.get('type')}.{resource.get('name')}"
    module = resource.get("module")
    return f"{module}.{base}" if module else base


def instance_addresses(resource: dict[str, Any]) -> set[str]:
    """Direcciones de instancia con el mismo formato que `address` en resource_changes del plan JSON."""
    base = resource_address(resource)
    instances = resource.get("instances")
    if not isinstance(instances, list) or not instances:
        raise GuardError(f"state remoto: {base} sin instancias legibles")
    result: set[str] = set()
    for instance in instances:
        if not isinstance(instance, dict):
            raise GuardError(f"state remoto: instancia inválida en {base}")
        key = instance.get("index_key")
        if key is None:
            result.add(base)
        elif isinstance(key, bool) or not isinstance(key, (int, str)):
            raise GuardError(f"state remoto: index_key no soportado en {base}")
        elif isinstance(key, int):
            result.add(f"{base}[{key}]")
        else:
            result.add(f"{base}[{json.dumps(key)}]")
    return result


def state_managed_addresses(state: dict[str, Any] | None) -> set[str]:
    addresses: set[str] = set()
    if state is None:
        return addresses
    resources = state.get("resources", [])
    if not isinstance(resources, list):
        raise GuardError("state: resources inválido")
    for resource in resources:
        if isinstance(resource, dict) and resource.get("mode", "managed") == "managed":
            addresses |= instance_addresses(resource)
    return addresses


def plan_managed_addresses(plan: dict[str, Any]) -> set[str]:
    return {
        change["address"]
        for change in plan.get("resource_changes", [])
        if isinstance(change, dict)
        and change.get("mode", "managed") == "managed"
        and isinstance(change.get("address"), str)
    }


def json_prior_addresses(plan: dict[str, Any]) -> set[str]:
    """Instancias administradas del prior_state del plan JSON (módulo raíz y módulos hijos)."""
    root = plan.get("prior_state", {}).get("values", {}).get("root_module", {})
    addresses: set[str] = set()
    pending = [root] if isinstance(root, dict) else []
    while pending:
        module = pending.pop()
        for resource in module.get("resources", []) or []:
            if resource.get("mode", "managed") == "managed":
                addresses.add(resource["address"])
        pending.extend(module.get("child_modules", []) or [])
    return addresses


def require_same_addresses(plan: dict[str, Any], state: dict[str, Any], label: str) -> None:
    """Vincula el plan con el state aprobado: mismo conjunto de instancias administradas, sin parciales."""
    planned, current = plan_managed_addresses(plan), state_managed_addresses(state)
    if planned != current:
        missing = sorted(current - planned)[:5]
        extra = sorted(planned - current)[:5]
        raise GuardError(
            f"{label}: el plan no corresponde al state aprobado (faltan {missing}, sobran {extra})"
        )


def state_cycle(state: dict[str, Any]) -> Any:
    outputs = state.get("outputs")
    if not isinstance(outputs, dict):
        raise GuardError("state remoto: faltan outputs")
    entry = outputs.get("lab_cycle_id")
    return entry.get("value") if isinstance(entry, dict) else None


def validate_state(state: dict[str, Any] | None, identity: dict[str, Any]) -> str:
    """State activo del ciclo aprobado: lineage, serial, ciclo y recursos exclusivamente de lab."""
    if state is None:
        raise GuardError("state remoto: ausente; solo el primer despliegue admite un state vacío")
    lineage = state.get("lineage")
    if not isinstance(lineage, str) or lineage != identity.get("lineage"):
        raise GuardError("state remoto: lineage no coincide con la identidad aprobada")
    serial = state.get("serial")
    if isinstance(serial, bool) or not isinstance(serial, int) or serial < identity["minimum_serial"]:
        raise GuardError("state remoto: serial anterior a la identidad aprobada")
    cycle = state_cycle(state)
    if not isinstance(cycle, str) or cycle != identity.get("lab_cycle_id"):
        raise GuardError("state remoto: lab_cycle_id no coincide con la identidad aprobada")

    managed = 0
    for resource in state.get("resources", []):
        if not isinstance(resource, dict) or resource.get("mode", "managed") != "managed":
            continue
        managed += 1
        address = resource_address(resource)
        rtype = resource.get("type")
        module = resource.get("module")
        if rtype in FORBIDDEN_TYPES or address in FORBIDDEN_ADDRESSES:
            raise GuardError(f"state remoto: recurso persistente prohibido: {address}")
        if module not in ALLOWED_MODULES:
            raise GuardError(f"state remoto: módulo/dirección fuera de lab: {address}")
    if managed == 0:
        raise GuardError("state remoto: no contiene recursos activos")
    return cycle


# ---------------------------------------------------------------------------------------------------------
# Vinculación plan binario ↔ JSON ↔ state (todos los modos)
# ---------------------------------------------------------------------------------------------------------


def validate_binding(
    plan: dict[str, Any],
    binary: dict[str, Any],
    state: dict[str, Any] | None,
    identity: dict[str, Any],
    mode: str,
) -> None:
    if binary["format"] != EXPECTED_PLAN_FORMAT:
        raise GuardError(f"plan binario: formato {binary['format']!r} no verificado")
    for label, version in (("binario", binary["terraform_version"]), ("JSON", plan.get("terraform_version"))):
        if version != EXPECTED_TERRAFORM_VERSION:
            raise GuardError(
                f"plan {label}: Terraform {version!r}; el formato solo está verificado con {EXPECTED_TERRAFORM_VERSION}"
            )
    if plan.get("errored") is not False:
        raise GuardError("plan JSON: generado con errores o sin indicador errored")
    if plan.get("complete") is not True or not binary["complete"] or binary["targets"]:
        raise GuardError(f"plan parcial (-target o acciones diferidas): {binary['targets'][:5]}")
    if binary["destroy"] != (mode == "destroy"):
        raise GuardError("plan binario: el modo de plan (normal/destroy) no corresponde al modo del guard")

    backend = binary["backend"]
    if not isinstance(backend, dict) or backend["type"] != EXPECTED_BACKEND_TYPE:
        raise GuardError("plan binario: backend distinto de s3")
    if backend["workspace"] != EXPECTED_WORKSPACE:
        raise GuardError("plan binario: workspace distinto de default")
    if not isinstance(backend["config"], dict):
        raise GuardError("plan binario: configuración de backend ilegible")
    exact_backend(backend["config"], identity["backend"], "plan binario: backend")

    variables = plan.get("variables")
    if not isinstance(variables, dict):
        raise GuardError("plan JSON: faltan variables")
    if "lab_cycle_id" not in binary["variables"]:
        raise GuardError("plan binario: falta la variable lab_cycle_id")
    for name, value in binary["variables"].items():
        entry = variables.get(name)
        if not isinstance(entry, dict) or entry.get("value") != value:
            raise GuardError(f"plan JSON y binario no coinciden en la variable {name}")

    binary_managed = {address for address in binary["changes"] if not DATA_ADDRESS_RE.match(address)}
    if binary_managed != plan_managed_addresses(plan):
        raise GuardError("plan JSON y binario no contienen los mismos cambios de recursos")
    if binary["outputs"] != set(plan.get("output_changes", {}) or {}):
        raise GuardError("plan JSON y binario no contienen los mismos outputs")

    embedded = binary["prior_state"]
    current = state_managed_addresses(state)
    if state is None:
        if embedded.get("lineage") != "" or embedded.get("serial") != 0 or state_managed_addresses(embedded):
            raise GuardError("plan binario: generado contra un state existente, pero el state aprobado está vacío")
    else:
        if embedded.get("lineage") != state.get("lineage") or embedded.get("serial") != state.get("serial"):
            raise GuardError("plan binario: generado contra otro state o una versión distinta (lineage/serial)")
    if state_managed_addresses(embedded) != current:
        raise GuardError("plan binario: el state previo embebido no corresponde al state aprobado")
    if json_prior_addresses(plan) != current:
        raise GuardError("plan JSON: prior_state no corresponde al state aprobado")


# ---------------------------------------------------------------------------------------------------------
# Modos
# ---------------------------------------------------------------------------------------------------------


def planned_output(plan: dict[str, Any], name: str) -> Any:
    entry = plan.get("planned_values", {}).get("outputs", {}).get(name)
    return entry.get("value") if isinstance(entry, dict) else None


def check_lab_scope(change: dict[str, Any], label: str) -> None:
    if change.get("mode", "managed") != "managed":
        return
    address = change.get("address")
    if change.get("type") in FORBIDDEN_TYPES or address in FORBIDDEN_ADDRESSES:
        raise GuardError(f"{label}: recurso persistente prohibido: {address}")
    if change.get("module_address") not in ALLOWED_MODULES:
        raise GuardError(f"{label}: recurso fuera de los módulos de lab: {address}")


def validate_deploy_plan(
    plan: dict[str, Any], binary: dict[str, Any], state: dict[str, Any] | None, identity: dict[str, Any]
) -> str:
    planned_cycles = {planned_output(plan, "lab_cycle_id"), binary["variables"].get("lab_cycle_id")}
    if planned_output(plan, "teardown_mode") is not False:
        raise GuardError("deploy: teardown_mode debe ser false; el apagado usa los modos prepare/destroy")

    changes = plan.get("resource_changes")
    if not isinstance(changes, list):
        raise GuardError("deploy: faltan resource_changes")
    for change in changes:
        if not isinstance(change, dict) or not isinstance(change.get("change"), dict):
            raise GuardError("deploy: resource_change inválido")
        check_lab_scope(change, "deploy")

    active = state_managed_addresses(state)
    if not active:
        # Primer despliegue del ciclo: state ausente o conservado vacío tras un destroy verificado.
        if planned_cycles != {identity["lab_cycle_id"]}:
            raise GuardError("deploy: lab_cycle_id del plan no coincide con la identidad aprobada")
        if state is None:
            if identity.get("lineage") is not None:
                raise GuardError("deploy: la identidad registra un lineage, pero no hay state remoto")
        elif not isinstance(identity.get("lineage"), str) or state.get("lineage") != identity["lineage"]:
            raise GuardError("deploy: state remoto vacío con lineage distinto del aprobado")
        elif (
            isinstance(state.get("serial"), bool)
            or not isinstance(state.get("serial"), int)
            or state["serial"] < identity["minimum_serial"]
        ):
            raise GuardError("deploy: state remoto vacío con serial anterior al aprobado")
        for change in changes:
            if change.get("mode", "managed") == "managed" and change["change"].get("actions") not in (["create"], ["no-op"]):
                raise GuardError(f"deploy: el primer despliegue solo crea recursos: {change.get('address')}")
        return "primer despliegue"

    # Actualización: el state está activo y pertenece al ciclo aprobado; el ciclo no puede cambiar.
    # validate_state exige identidad == ciclo del state; aquí se exige plan (JSON y binario) == ciclo del state.
    current_cycle = validate_state(state, identity)
    if planned_cycles != {current_cycle}:
        raise GuardError("deploy: cambiar lab_cycle_id sobre un state activo está prohibido")
    missing = sorted(active - plan_managed_addresses(plan))
    if missing:
        raise GuardError(f"deploy: plan parcial, faltan instancias del state: {missing[:5]}")
    for change in changes:
        actions = change["change"].get("actions")
        if STATEFUL_RE.fullmatch(str(change.get("address"))) and isinstance(actions, list) and "delete" in actions:
            raise GuardError(
                f"deploy: eliminar o reemplazar {change.get('address')} solo se admite en el apagado validado"
            )
    return "actualización del mismo ciclo"


def validate_allowed_update(change: dict[str, Any]) -> None:
    address = change.get("address")
    body = change.get("change")
    if not isinstance(address, str) or not isinstance(body, dict):
        raise GuardError("plan: resource_change inválido")
    actions = body.get("actions")
    if actions in (["no-op"], ["read"]):
        return
    if actions != ["update"]:
        raise GuardError(f"plan: acción no permitida en preparación: {address} {actions}")

    before, after = body.get("before"), body.get("after")
    allowed = ALLOWED_PATHS.get(address)
    if ECS_RE.fullmatch(address):
        allowed = {"desired_count"}
    if allowed is None:
        raise GuardError(f"plan: recurso modificado fuera de allowlist: {address}")
    changed = diff_paths(before, after)
    if not changed or not changed <= allowed:
        raise GuardError(f"plan: atributos no permitidos en {address}: {sorted(changed - allowed)}")

    if address in REQUIRED_FINAL:
        attribute, value = REQUIRED_FINAL[address]
        if after.get(attribute) is not value:
            raise GuardError(f"plan: {address} debe terminar con {attribute}={str(value).lower()}")
    if ECS_RE.fullmatch(address) and after.get("desired_count") != 0:
        raise GuardError(f"plan: {address} debe terminar con desired_count=0")


def diff_paths(before: Any, after: Any, prefix: str = "") -> set[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        paths: set[str] = set()
        for key in before.keys() | after.keys():
            child = f"{prefix}.{key}" if prefix else key
            paths |= diff_paths(before.get(key), after.get(key), child)
        return paths
    if before != after:
        return {prefix}
    return set()


def validate_prepare_plan(plan: dict[str, Any], state: dict[str, Any], state_cycle: str) -> None:
    prior = plan.get("prior_state", {}).get("values", {}).get("outputs", {})
    prior_cycle = prior.get("lab_cycle_id", {}).get("value")
    planned_cycle = planned_output(plan, "lab_cycle_id")
    if prior_cycle != state_cycle:
        raise GuardError("plan: lab_cycle_id del prior_state no coincide con el state aprobado")
    if planned_cycle != state_cycle:
        raise GuardError("plan: cambiar lab_cycle_id sobre un state activo está prohibido")

    changed_addresses: set[str] = set()
    for change in plan.get("resource_changes", []):
        validate_allowed_update(change)
        actions = change.get("change", {}).get("actions")
        if actions == ["update"]:
            changed_addresses.add(change["address"])
    if RDS not in changed_addresses or SPA not in changed_addresses:
        raise GuardError("plan: faltan los cambios obligatorios de RDS o del bucket SPA")

    for name, change in plan.get("output_changes", {}).items():
        actions = change.get("actions") if isinstance(change, dict) else None
        if actions in (["no-op"], None):
            continue
        if name != "teardown_mode" or actions != ["update"] or change.get("after") is not True:
            raise GuardError(f"plan: output modificado fuera de allowlist: {name}")
    # Al final, para conservar diagnósticos específicos: el plan cubre exactamente el state aprobado.
    require_same_addresses(plan, state, "plan")


def validate_destroy_plan(plan: dict[str, Any], state: dict[str, Any], state_cycle: str) -> None:
    prior = plan.get("prior_state", {}).get("values", {}).get("outputs", {})
    prior_cycle = prior.get("lab_cycle_id", {}).get("value")
    if prior_cycle != state_cycle:
        raise GuardError("destroy: lab_cycle_id del prior_state no coincide con el state aprobado")
    # Un destroy parcial (-target) o generado contra otro state deja residuos facturables o borra lo ajeno.
    require_same_addresses(plan, state, "destroy")

    deleted = 0
    rds_checked = False
    for resource_change in plan.get("resource_changes", []):
        if not isinstance(resource_change, dict):
            raise GuardError("destroy: resource_change inválido")
        body = resource_change.get("change")
        address = resource_change.get("address")
        actions = body.get("actions") if isinstance(body, dict) else None
        if actions in (["no-op"], ["read"]):
            continue
        if resource_change.get("mode", "managed") != "managed" or actions != ["delete"]:
            raise GuardError(f"destroy: solo se permiten eliminaciones de recursos administrados: {address} {actions}")
        module = resource_change.get("module_address")
        resource_type = resource_change.get("type")
        if resource_type in FORBIDDEN_TYPES or module not in ALLOWED_MODULES:
            raise GuardError(f"destroy: recurso fuera del state lab permitido: {address}")
        deleted += 1
        if address == RDS:
            before = body.get("before")
            if not isinstance(before, dict):
                raise GuardError("destroy: no se pudo inspeccionar la configuración previa de RDS")
            if before.get("skip_final_snapshot") is not True or before.get("final_snapshot_identifier") is not None:
                raise GuardError("destroy: RDS debe omitir el snapshot final y no definir identificador")
            if before.get("deletion_protection") is not False:
                raise GuardError("destroy: RDS conserva deletion_protection=true")
            rds_checked = True
        elif address in REQUIRED_FINAL:
            # Sin el apply de preparación, S3 o ALB fallarían después de borrar parte del entorno.
            attribute, value = REQUIRED_FINAL[address]
            before = body.get("before")
            if not isinstance(before, dict) or before.get(attribute) is not value:
                raise GuardError(
                    f"destroy: {address} requiere {attribute}={str(value).lower()} antes de destruir"
                )
    if deleted == 0:
        raise GuardError("destroy: el plan no elimina recursos")
    if not rds_checked:
        raise GuardError("destroy: falta la eliminación comprobable del recurso RDS")

    for name, change in plan.get("output_changes", {}).items():
        actions = change.get("actions") if isinstance(change, dict) else None
        if actions not in (["delete"], ["no-op"], None):
            raise GuardError(f"destroy: cambio de output inesperado: {name} {actions}")


def verify(args: argparse.Namespace) -> str:
    identity = load_json(args.identity)
    metadata = load_json(args.backend_metadata)
    state = load_state(args.state)
    plan = load_json(args.plan)

    if workspace(args.workspace_file) != EXPECTED_WORKSPACE:
        raise GuardError("workspace activo distinto de default")
    validate_identity(identity)
    exact_backend(backend_config(metadata), identity["backend"])

    expected_sha = str(args.plan_sha256 or "").lower()
    if not SHA256_RE.fullmatch(expected_sha):
        raise GuardError("SHA-256 aprobado del plan binario ausente o inválido")
    actual_sha = sha256_file(args.plan_file)
    if actual_sha != expected_sha:
        raise GuardError("plan binario: SHA-256 distinto del aprobado")
    binary = read_plan_file(args.plan_file)
    validate_binding(plan, binary, state, identity, args.mode)

    if args.mode == "deploy":
        return validate_deploy_plan(plan, binary, state, identity)
    cycle = validate_state(state, identity)
    if args.mode == "prepare":
        validate_prepare_plan(plan, state, cycle)
        return "preparación del apagado"
    validate_destroy_plan(plan, state, cycle)
    return "destrucción"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    result.add_argument("--mode", choices=("deploy", "prepare", "destroy"), required=True)
    result.add_argument("--identity", type=Path, required=True)
    result.add_argument("--backend-metadata", type=Path, required=True)
    result.add_argument("--workspace-file", type=Path, required=True)
    result.add_argument("--state", type=Path, required=True)
    result.add_argument("--plan", type=Path, required=True, help="JSON de terraform show -json")
    result.add_argument("--plan-file", type=Path, required=True, help="plan binario de terraform plan -out")
    result.add_argument("--plan-sha256", required=True, help="SHA-256 aprobado del plan binario")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        kind = verify(args)
    except GuardError as exc:
        print(f"FAIL {exc}")
        return 1
    except (AttributeError, KeyError, TypeError) as exc:
        # JSON con estructura inesperada: se rechaza siempre (fail-closed) sin traza ni contenido del state.
        print(f"FAIL estructura JSON inesperada ({type(exc).__name__})")
        return 1
    print(
        f"OK   {kind}: backend, workspace, state, ciclo y allowlist verificados; "
        f"aplicar solo el plan binario con SHA-256 {args.plan_sha256.lower()}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
