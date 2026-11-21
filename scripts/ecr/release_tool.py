#!/usr/bin/env python3
"""Herramienta del pipeline de publicación en ECR (PR-6, ADR-AWS-06). Solo biblioteca estándar; se ejecuta con
`python3 -I`. No usa credenciales ni contacta con AWS: trabaja sobre archivos y sobre JSON ya descargados.

Subcomandos:
  images                                       lista las 9 imágenes (TSV) para los scripts de shell
  buildkit                                     imagen de BuildKit fijada por digest
  describe RELEASE --sha SHA                   verifica cada archivo OCI y escribe RELEASE/images.json
  verify-ref --sha SHA --ref REF ...           el SHA es de main (first-parent), con los 5 checks de ese commit
                                               en ejecuciones push de main y, si se publica, el Environment
                                               protegido
  vuln-policy RELEASE --exceptions FILE        aplica la política de vulnerabilidades y secretos (Trivy JSON)
  runtime-contents RELEASE --lockfile FILE     las imágenes runtime no contienen dependencias de desarrollo
  verify-release RELEASE --sha SHA --expected-images-sha256 H
                                               integridad de lo descargado antes de publicar
  summary RELEASE                              resumen Markdown para GITHUB_STEP_SUMMARY
  manifest RELEASE --states FILE --registry R  manifiesto de publicación (commit, etiquetas, digest)
  published-summary RELEASE                    resumen Markdown de lo publicado
Sale con código 1 ante cualquier incumplimiento (fallo seguro) y 2 ante un uso incorrecto.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tarfile
from pathlib import Path

PLATFORM = {"os": "linux", "architecture": "amd64"}
REPOSITORY_PREFIX = "spectra"
SOURCE_REPOSITORY = "https://github.com/Torres21C/spectra-shop"
BUILDKIT_IMAGE = "moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe"

# Las 9 imágenes. Coinciden con local.repositories de infra/terraform/environments/lab y con las etiquetas que
# consumen las task definitions (<sha> y <sha>-migrate); lo comprueba scripts/tests/test_images_config.py.
IMAGES = [
    *[
        {
            "name": f"{svc}-service-{kind}",
            "repository": f"{REPOSITORY_PREFIX}/{svc}-service",
            "kind": kind,
            "context": ".",
            "dockerfile": f"apps/{svc}-service/Dockerfile",
            "target": kind,
            "tag_suffix": "-migrate" if kind == "migrate" else "",
        }
        for svc in ("identity", "catalog", "commerce", "audit")
        for kind in ("runtime", "migrate")
    ],
    {
        "name": "db-ops",
        "repository": f"{REPOSITORY_PREFIX}/db-ops",
        "kind": "db-ops",
        "context": "infra/postgres",
        "dockerfile": "infra/postgres/Dockerfile",
        "target": "",
        "tag_suffix": "",
    },
]

REQUIRED_CHECKS = [
    "Lint, tipos, pruebas y build",
    "SAST (Semgrep)",
    "Secretos (Gitleaks)",
    "SCA y SBOM",
    "Terraform (validación estática, sin AWS)",
]
REQUIRED_WORKFLOWS = {".github/workflows/ci.yml", ".github/workflows/iac.yml"}
GITHUB_ACTIONS_APP_ID = 15368
PUBLISH_ENVIRONMENT = "ecr-publish-lab"
MAX_EXCEPTION_DAYS = 30
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
# Herramientas de desarrollo que nunca deben llegar a una imagen runtime (además de lo que el lockfile marca
# como dev/devOptional). picomatch: AWS-07 (su excepción SCA no cubre AWS).
RUNTIME_DENYLIST = {
    "prisma", "typescript", "vite", "vitest", "eslint", "prettier", "ts-node", "tsx", "picomatch",
    "@nestjs/cli", "@nestjs/testing", "supertest", "@cyclonedx/cyclonedx-npm",
}


class PolicyError(Exception):
    """Incumplimiento: el pipeline debe detenerse."""


def fail(message: str) -> None:
    raise PolicyError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tag_for(image: dict, sha: str) -> str:
    return sha + image["tag_suffix"]


def archive_name(image: dict) -> str:
    return f"images/{image['name']}.tar"


def require_sha(sha: str) -> str:
    if not SHA_RE.match(sha or ""):
        fail(f"SHA inválido: {sha!r} (se exigen 40 caracteres hexadecimales en minúsculas)")
    return sha


# --------------------------------------------------------------------------------------------- archivos OCI


def inspect_oci_archive(path: Path, sha: str) -> dict:
    """Comprueba un archivo OCI (salida type=oci de BuildKit) y devuelve sus digest.

    Exige: un único manifiesto de imagen (sin índice ni atestaciones), todos los blobs presentes y con el
    sha256 y tamaño declarados, plataforma linux/amd64 y la etiqueta org.opencontainers.image.revision = sha.
    """
    if not path.is_file():
        fail(f"{path}: no existe")
    with tarfile.open(path, "r") as tar:
        members = {m.name.lstrip("./"): m for m in tar.getmembers() if m.isfile()}

        def read(name: str) -> bytes:
            member = members.get(name)
            if member is None:
                fail(f"{path}: falta {name}")
            handle = tar.extractfile(member)
            return handle.read() if handle else b""

        def blob(descriptor: dict) -> bytes:
            algorithm, _, hexdigest = descriptor["digest"].partition(":")
            if algorithm != "sha256" or not re.fullmatch(r"[0-9a-f]{64}", hexdigest):
                fail(f"{path}: digest no admitido {descriptor['digest']}")
            name = f"blobs/sha256/{hexdigest}"
            member = members.get(name)
            if member is None:
                fail(f"{path}: falta el blob {descriptor['digest']}")
            digest = hashlib.sha256()
            handle = tar.extractfile(member)
            data = bytearray()
            keep = descriptor.get("mediaType", "").endswith("json")
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
                if keep:
                    data.extend(chunk)
            if digest.hexdigest() != hexdigest:
                fail(f"{path}: el blob {descriptor['digest']} no coincide con su contenido")
            if member.size != descriptor.get("size"):
                fail(f"{path}: tamaño del blob {descriptor['digest']} distinto del declarado")
            return bytes(data)

        index = json.loads(read("index.json"))
        manifests = index.get("manifests", [])
        if len(manifests) != 1:
            fail(f"{path}: se esperaba un único manifiesto y hay {len(manifests)} (¿atestaciones activadas?)")
        descriptor = manifests[0]
        if descriptor.get("mediaType") != OCI_MANIFEST:
            fail(f"{path}: el manifiesto es {descriptor.get('mediaType')}, no una imagen OCI")
        manifest = json.loads(blob(descriptor))
        config = json.loads(blob(manifest["config"]))
        for layer in manifest.get("layers", []):
            blob(layer)

    if config.get("os") != PLATFORM["os"] or config.get("architecture") != PLATFORM["architecture"]:
        fail(f"{path}: plataforma {config.get('os')}/{config.get('architecture')}, se exige linux/amd64")
    labels = (config.get("config") or {}).get("Labels") or {}
    revision = labels.get("org.opencontainers.image.revision")
    if revision != sha:
        fail(f"{path}: la imagen es del commit {revision!r}, no de {sha}")
    return {
        "manifest_digest": descriptor["digest"],
        "manifest_media_type": descriptor["mediaType"],
        "manifest_size": descriptor["size"],
        "config_digest": manifest["config"]["digest"],
        "layers": len(manifest.get("layers", [])),
        "layers_size": sum(layer.get("size", 0) for layer in manifest.get("layers", [])),
        "platform": f"{config['os']}/{config['architecture']}",
        "revision": revision,
        "user": (config.get("config") or {}).get("User", ""),
    }


def cmd_describe(args) -> None:
    sha = require_sha(args.sha)
    release = Path(args.release)
    entries = []
    for image in IMAGES:
        archive = release / archive_name(image)
        info = inspect_oci_archive(archive, sha)
        entries.append({
            "name": image["name"],
            "kind": image["kind"],
            "repository": image["repository"],
            "tag": tag_for(image, sha),
            "dockerfile": image["dockerfile"],
            "target": image["target"] or "(final)",
            "archive": archive_name(image),
            "archive_sha256": sha256_file(archive),
            "archive_size": archive.stat().st_size,
            **info,
        })
    if len({e["manifest_digest"] for e in entries}) != len(entries):
        fail("dos imágenes distintas tienen el mismo digest: revisar targets y etiquetas")
    document = {"schema": "spectra-ecr-images/v1", "commit": sha, "platform": "linux/amd64",
                "buildkit": BUILDKIT_IMAGE, "images": entries}
    (release / "images.json").write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    print(f"OK   {len(entries)} imágenes del commit {sha} verificadas (linux/amd64, blobs íntegros)")


# ------------------------------------------------------------------------------ verificación del commit


def cmd_verify_ref(args) -> None:
    sha = require_sha(args.sha)
    if args.ref != "refs/heads/main":
        fail(f"el workflow debe lanzarse desde main (ref actual: {args.ref})")
    first_parent = {line.strip() for line in Path(args.first_parent).read_text().splitlines() if line.strip()}
    if sha not in first_parent:
        fail(f"{sha} no es un commit de la historia first-parent de main: ser ancestro de main no basta")

    runs = json.loads(Path(args.workflow_runs).read_text()).get("workflow_runs", [])
    good_suites = {}
    for run in runs:
        if (run.get("head_sha") == sha and run.get("event") == "push" and run.get("head_branch") == "main"
                and run.get("status") == "completed" and run.get("conclusion") == "success"
                and run.get("path") in REQUIRED_WORKFLOWS):
            good_suites[run["check_suite_id"]] = run["path"]
    missing_workflows = REQUIRED_WORKFLOWS - set(good_suites.values())
    if missing_workflows:
        fail(f"sin ejecución push de main en success para {sorted(missing_workflows)} en {sha}")

    check_runs = json.loads(Path(args.check_runs).read_text()).get("check_runs", [])
    for name in REQUIRED_CHECKS:
        candidates = [c for c in check_runs if c.get("name") == name]
        if not candidates:
            fail(f"falta el check requerido «{name}» en {sha}")
        bad = [c for c in candidates if not (
            c.get("head_sha") == sha and c.get("status") == "completed" and c.get("conclusion") == "success"
            and (c.get("app") or {}).get("id") == GITHUB_ACTIONS_APP_ID
            and (c.get("check_suite") or {}).get("id") in good_suites)]
        if bad:
            c = bad[0]
            fail(f"check «{name}» no aprobado para {sha} en una ejecución push de main "
                 f"(conclusión {c.get('conclusion')}, app {(c.get('app') or {}).get('slug')}, "
                 f"suite {(c.get('check_suite') or {}).get('id')})")

    warnings = []
    if args.publish == "true":
        warnings = verify_environment(args.environment, args.branch_policies)
    for warning in warnings:
        print(f"AVISO {warning}")
    print(f"OK   {sha}: commit first-parent de main y {len(REQUIRED_CHECKS)} checks aprobados en push de main"
          + ("; Environment protegido" if args.publish == "true" else ""))


def verify_environment(environment_file: str | None, policies_file: str | None) -> list:
    if not environment_file or not Path(environment_file).is_file():
        fail(f"el Environment {PUBLISH_ENVIRONMENT} no existe o no se pudo leer: no se publica")
    env = json.loads(Path(environment_file).read_text())
    if env.get("name") != PUBLISH_ENVIRONMENT:
        fail(f"Environment inesperado: {env.get('name')!r}")
    rules = env.get("protection_rules") or []
    reviewers = [r for r in rules if r.get("type") == "required_reviewers" and (r.get("reviewers") or [])]
    if not reviewers:
        fail(f"el Environment {PUBLISH_ENVIRONMENT} no exige revisores: GitHub lo habría creado sin protección")
    policy = env.get("deployment_branch_policy") or {}
    if policy != {"protected_branches": False, "custom_branch_policies": True}:
        fail(f"el Environment debe limitarse a ramas personalizadas (solo main); política actual: {policy}")
    if not policies_file or not Path(policies_file).is_file():
        fail("no se pudieron leer las políticas de rama del Environment")
    branch_policies = json.loads(Path(policies_file).read_text()).get("branch_policies", [])
    names = [(p.get("name"), p.get("type", "branch")) for p in branch_policies]
    if names != [("main", "branch")]:
        fail(f"el Environment solo puede admitir la rama main; políticas actuales: {names}")
    warnings = []
    if env.get("can_admins_bypass", True):
        warnings.append("los administradores pueden omitir las reglas del Environment (recomendado: desactivarlo)")
    if not any(r.get("prevent_self_review") for r in reviewers):
        warnings.append("la autoaprobación está permitida (aceptable con un solo mantenedor; documentado)")
    return warnings


# ------------------------------------------------------------------------- política de vulnerabilidades


def load_exceptions(path: Path, today: dt.date) -> list:
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or data.get("policy_version") != 1 or not isinstance(data.get("exceptions"), list):
        fail(f"{path}: formato no válido (se espera policy_version = 1 y una lista exceptions)")
    known_images = {image["name"] for image in IMAGES}
    valid = []
    for i, item in enumerate(data["exceptions"]):
        where = f"{path}: excepción #{i + 1}"
        required = ["vulnerability", "package", "images", "severity", "justification", "approved_by",
                    "approved_on", "expires_on"]
        missing = [k for k in required if not item.get(k)]
        if missing:
            fail(f"{where}: faltan campos {missing}")
        if not re.fullmatch(r"(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})", item["vulnerability"]):
            fail(f"{where}: identificador no válido {item['vulnerability']!r} (sin comodines)")
        if not re.fullmatch(r"[@a-z0-9][a-z0-9._/@+-]*", item["package"]) or "*" in item["package"]:
            fail(f"{where}: paquete no válido {item['package']!r}")
        images = item["images"]
        if not isinstance(images, list) or not images or not set(images) <= known_images:
            fail(f"{where}: images debe ser una lista no vacía de imágenes conocidas (sin comodines)")
        if item["severity"] != "HIGH":
            fail(f"{where}: solo se admiten excepciones HIGH sin corrección (CRITICAL nunca)")
        if len(item["justification"].strip()) < 20:
            fail(f"{where}: justificación insuficiente")
        try:
            approved = dt.date.fromisoformat(item["approved_on"])
            expires = dt.date.fromisoformat(item["expires_on"])
        except ValueError:
            fail(f"{where}: fechas no válidas (AAAA-MM-DD)")
        if expires < approved or (expires - approved).days > MAX_EXCEPTION_DAYS:
            fail(f"{where}: la caducidad debe estar a 30 días como máximo de la aprobación")
        valid.append({**item, "expired": today > expires})
    return valid


def cmd_vuln_policy(args) -> None:
    release = Path(args.release)
    today = dt.date.fromisoformat(args.today) if args.today else dt.datetime.now(dt.timezone.utc).date()
    exceptions = load_exceptions(Path(args.exceptions), today)
    used = set()
    blocked, excepted, reported = [], [], []
    for image in IMAGES:
        report_file = release / "scans" / f"{image['name']}.trivy.json"
        if not report_file.is_file():
            fail(f"falta el informe de Trivy de {image['name']}")
        report = json.loads(report_file.read_text())
        for result in report.get("Results") or []:
            for secret in result.get("Secrets") or []:
                blocked.append((image["name"], "SECRET", secret.get("RuleID"), result.get("Target"), "secreto en la imagen"))
            for vuln in result.get("Vulnerabilities") or []:
                severity = vuln.get("Severity", "UNKNOWN")
                entry = (image["name"], severity, vuln.get("VulnerabilityID"), vuln.get("PkgName"),
                         "con corrección " + vuln["FixedVersion"] if vuln.get("FixedVersion") else "sin corrección")
                if severity == "CRITICAL":
                    blocked.append(entry)
                elif severity == "HIGH" and vuln.get("FixedVersion"):
                    blocked.append(entry)
                elif severity == "HIGH":
                    match = [i for i, e in enumerate(exceptions) if e["vulnerability"] == vuln.get("VulnerabilityID")
                             and e["package"] == vuln.get("PkgName") and image["name"] in e["images"]]
                    active = [i for i in match if not exceptions[i]["expired"]]
                    if active:
                        used.add(active[0])
                        excepted.append(entry)
                    else:
                        blocked.append(entry + (("excepción caducada",) if match else ()))
                else:
                    reported.append(entry)
    unused = [exceptions[i]["vulnerability"] for i in range(len(exceptions)) if i not in used]
    summary = {
        "schema": "spectra-image-policy/v1",
        "date": today.isoformat(),
        "status": "fail" if blocked else "pass",
        "blocked": [list(b) for b in blocked],
        "excepted": [list(e) for e in excepted],
        "reported_counts": {s: sum(1 for r in reported if r[1] == s) for s in ("MEDIUM", "LOW", "UNKNOWN")},
        "unused_exceptions": unused,
    }
    (release / "policy-report.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    for b in blocked:
        print("BLOQUEO", " | ".join(str(x) for x in b))
    for e in excepted:
        print("EXCEPCIÓN", " | ".join(str(x) for x in e))
    for u in unused:
        print(f"AVISO excepción sin uso (revisar o retirar): {u}")
    print(f"Política: {len(blocked)} bloqueos, {len(excepted)} excepciones aplicadas, "
          f"MEDIUM/LOW/UNKNOWN reportadas: {summary['reported_counts']}")
    if blocked:
        fail("la política de vulnerabilidades bloquea la publicación")


# ------------------------------------------------------------------------ contenido de imágenes runtime


def dev_only_packages(lockfile: Path) -> set:
    """(nombre, versión) que el lockfile solo instala como dev/devOptional (nunca en producción)."""
    packages = json.loads(lockfile.read_text()).get("packages", {})
    dev, prod = set(), set()
    for key, meta in packages.items():
        if "node_modules/" not in key or not meta.get("version"):
            continue
        name = key.rsplit("node_modules/", 1)[1]
        target = dev if (meta.get("dev") or meta.get("devOptional")) else prod
        target.add((name, meta["version"]))
    return dev - prod


def component_path(component: dict) -> str:
    for prop in component.get("properties") or []:
        if prop.get("name") in ("aquasecurity:trivy:FilePath", "aquasecurity:trivy:PkgPath"):
            return prop.get("value") or ""
    return ""


def npm_components(sbom: dict) -> tuple:
    """(paquetes de la aplicación en /app, paquetes npm de la imagen base fuera de /app)."""
    app, base = set(), set()
    for component in sbom.get("components") or []:
        purl = component.get("purl") or ""
        if not purl.startswith("pkg:npm/"):
            continue
        name = component.get("group") + "/" + component["name"] if component.get("group") else component["name"]
        entry = (name, component.get("version", ""))
        (app if component_path(component).startswith("app/") else base).add(entry)
    return app, base


def cmd_runtime_contents(args) -> None:
    """Las dependencias de la APLICACIÓN (/app/node_modules) de las imágenes runtime no incluyen paquetes que el
    lockfile solo instala como dev/devOptional ni herramientas de la lista de exclusión. Los paquetes npm de la
    imagen base (CLI de npm, yarn en /usr/local y /opt) no son dependencias de la aplicación: se cuentan aparte y
    sus vulnerabilidades las cubre la política de vulnerabilidades."""
    release = Path(args.release)
    dev_only = dev_only_packages(Path(args.lockfile))
    problems = []
    base_packages = {}
    checked = 0
    for image in IMAGES:
        if image["kind"] != "runtime":
            continue
        sbom = json.loads((release / "sbom" / f"{image['name']}.cdx.json").read_text())
        app, base = npm_components(sbom)
        if not app:
            fail(f"{image['name']}: el SBOM no contiene paquetes npm de /app (SBOM vacío o sin rutas)")
        checked += 1
        base_packages[image["name"]] = len(base)
        for name, version in sorted(app):
            if (name, version) in dev_only:
                problems.append(f"{image['name']}: {name}@{version} es dependencia de desarrollo")
            elif name in RUNTIME_DENYLIST:
                problems.append(f"{image['name']}: {name}@{version} está en la lista de exclusión de runtime")
    report = {"schema": "spectra-runtime-contents/v1", "checked_images": checked, "problems": problems,
              "base_image_npm_packages": base_packages, "status": "fail" if problems else "pass"}
    (release / "runtime-contents.json").write_text(json.dumps(report, indent=2) + "\n")
    for p in problems:
        print("FAIL", p)
    for name, count in base_packages.items():
        if count:
            print(f"AVISO {name}: {count} paquetes npm de la imagen base fuera de /app (CLI de npm/yarn)")
    if problems:
        fail("hay dependencias de desarrollo en imágenes runtime")
    print(f"OK   {checked} imágenes runtime sin dependencias de desarrollo en /app")


# ------------------------------------------------------------------------ verificación antes de publicar


def cmd_verify_release(args) -> None:
    sha = require_sha(args.sha)
    release = Path(args.release)
    images_file = release / "images.json"
    if not re.fullmatch(r"[0-9a-f]{64}", args.expected_images_sha256 or ""):
        fail("falta el hash esperado de images.json (salida del job build-scan)")
    if sha256_file(images_file) != args.expected_images_sha256:
        fail("images.json no coincide con el generado por build-scan")
    document = json.loads(images_file.read_text())
    if document.get("commit") != sha:
        fail(f"images.json es del commit {document.get('commit')}, no de {sha}")
    by_name = {e["name"]: e for e in document.get("images", [])}
    if set(by_name) != {image["name"] for image in IMAGES}:
        fail("el conjunto de imágenes no es exactamente el de las 9 previstas")
    for image in IMAGES:
        entry = by_name[image["name"]]
        if entry["repository"] != image["repository"] or entry["tag"] != tag_for(image, sha):
            fail(f"{image['name']}: repositorio o etiqueta inesperados")
        archive = release / entry["archive"]
        if sha256_file(archive) != entry["archive_sha256"]:
            fail(f"{image['name']}: el archivo OCI cambió desde el análisis")
        info = inspect_oci_archive(archive, sha)
        if info["manifest_digest"] != entry["manifest_digest"]:
            fail(f"{image['name']}: el digest del manifiesto no coincide")
    for report, label in (("policy-report.json", "política de vulnerabilidades"),
                          ("runtime-contents.json", "contenido de runtime")):
        path = release / report
        if not path.is_file() or json.loads(path.read_text()).get("status") != "pass":
            fail(f"{label}: no consta como aprobada")
    print(f"OK   {len(by_name)} imágenes íntegras, del commit {sha}, con la política aprobada")


# ------------------------------------------------------------------------------- resumen y manifiesto


def vuln_counts(release: Path, name: str) -> dict:
    counts = {s: 0 for s in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN")}
    report = json.loads((release / "scans" / f"{name}.trivy.json").read_text())
    for result in report.get("Results") or []:
        for vuln in result.get("Vulnerabilities") or []:
            counts[vuln.get("Severity", "UNKNOWN")] = counts.get(vuln.get("Severity", "UNKNOWN"), 0) + 1
    return counts


def cmd_summary(args) -> None:
    release = Path(args.release)
    document = json.loads((release / "images.json").read_text())
    print(f"### Imágenes del commit `{document['commit']}` (linux/amd64)\n")
    print("| Imagen | Repositorio:etiqueta | Digest | C | H | M | L |")
    print("| --- | --- | --- | ---: | ---: | ---: | ---: |")
    for entry in document["images"]:
        counts = vuln_counts(release, entry["name"])
        print(f"| {entry['name']} | `{entry['repository']}:{entry['tag']}` | `{entry['manifest_digest']}` | "
              f"{counts['CRITICAL']} | {counts['HIGH']} | {counts['MEDIUM']} | {counts['LOW']} |")
    policy = json.loads((release / "policy-report.json").read_text())
    print(f"\nPolítica de vulnerabilidades: **{policy['status']}** · excepciones aplicadas: {len(policy['excepted'])}")


def cmd_manifest(args) -> None:
    release = Path(args.release)
    document = json.loads((release / "images.json").read_text())
    states = json.loads(Path(args.states).read_text())
    registry = args.registry
    images = []
    for entry in document["images"]:
        state = states.get(entry["name"]) or {}
        if state.get("digest") != entry["manifest_digest"]:
            fail(f"{entry['name']}: el digest publicado {state.get('digest')} no es el analizado")
        sbom = release / "sbom" / f"{entry['name']}.cdx.json"
        images.append({
            "name": entry["name"],
            "kind": entry["kind"],
            "repository": entry["repository"],
            "tag": entry["tag"],
            "digest": entry["manifest_digest"],
            "reference_by_tag": f"{registry}/{entry['repository']}:{entry['tag']}",
            "reference_by_digest": f"{registry}/{entry['repository']}@{entry['manifest_digest']}",
            "media_type": entry["manifest_media_type"],
            "platform": entry["platform"],
            "publication": state.get("publication"),
            "sbom_sha256": sha256_file(sbom),
            "vulnerabilities": vuln_counts(release, entry["name"]),
        })
    manifest = {
        "schema": "spectra-ecr-release/v1",
        "commit": document["commit"],
        "source": SOURCE_REPOSITORY,
        "registry": registry,
        "platform": document["platform"],
        "buildkit": document["buildkit"],
        "workflow_run": {
            "id": os.environ.get("GITHUB_RUN_ID"),
            "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "actor": os.environ.get("GITHUB_ACTOR"),
            "url": (f"{os.environ.get('GITHUB_SERVER_URL')}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/"
                    f"{os.environ.get('GITHUB_RUN_ID')}") if os.environ.get("GITHUB_RUN_ID") else None,
        },
        "generated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "policy": json.loads((release / "policy-report.json").read_text())["status"],
        "images": images,
        "terraform": {"image_tag": document["commit"]},
    }
    (release / "release-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"OK   manifiesto de publicación con {len(images)} imágenes")


def cmd_published_summary(args) -> None:
    manifest = json.loads((Path(args.release) / "release-manifest.json").read_text())
    print(f"### Publicación en ECR del commit `{manifest['commit']}`\n")
    print("| Imagen | Referencia por digest | Estado |")
    print("| --- | --- | --- |")
    for image in manifest["images"]:
        print(f"| {image['name']} | `{image['reference_by_digest']}` | {image['publication']} |")


def cmd_images(_args) -> None:
    for image in IMAGES:
        print("\t".join([image["name"], image["repository"], image["kind"], image["context"],
                         image["dockerfile"], image["target"] or "-", image["tag_suffix"] or "-", archive_name(image)]))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("images").set_defaults(func=cmd_images)
    sub.add_parser("buildkit").set_defaults(func=lambda _a: print(BUILDKIT_IMAGE))
    p = sub.add_parser("describe")
    p.add_argument("release"); p.add_argument("--sha", required=True); p.set_defaults(func=cmd_describe)
    p = sub.add_parser("verify-ref")
    p.add_argument("--sha", required=True); p.add_argument("--ref", required=True)
    p.add_argument("--first-parent", required=True); p.add_argument("--check-runs", required=True)
    p.add_argument("--workflow-runs", required=True); p.add_argument("--publish", choices=["true", "false"], required=True)
    p.add_argument("--environment"); p.add_argument("--branch-policies"); p.set_defaults(func=cmd_verify_ref)
    p = sub.add_parser("vuln-policy")
    p.add_argument("release"); p.add_argument("--exceptions", required=True); p.add_argument("--today")
    p.set_defaults(func=cmd_vuln_policy)
    p = sub.add_parser("runtime-contents")
    p.add_argument("release"); p.add_argument("--lockfile", required=True); p.set_defaults(func=cmd_runtime_contents)
    p = sub.add_parser("verify-release")
    p.add_argument("release"); p.add_argument("--sha", required=True)
    p.add_argument("--expected-images-sha256", required=True); p.set_defaults(func=cmd_verify_release)
    p = sub.add_parser("summary")
    p.add_argument("release"); p.set_defaults(func=cmd_summary)
    p = sub.add_parser("published-summary")
    p.add_argument("release"); p.set_defaults(func=cmd_published_summary)
    p = sub.add_parser("manifest")
    p.add_argument("release"); p.add_argument("--states", required=True); p.add_argument("--registry", required=True)
    p.set_defaults(func=cmd_manifest)
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except PolicyError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"FAIL error al procesar los datos ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
