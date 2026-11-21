"""Utilidades comunes de las pruebas del pipeline de publicación (sin red ni AWS)."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98"


def load_tool(name: str = "release_tool", path: str = "scripts/ecr/release_tool.py"):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _add(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def blob(data: bytes, media_type: str) -> dict:
    return {"mediaType": media_type, "digest": "sha256:" + hashlib.sha256(data).hexdigest(), "size": len(data)}


def make_oci(path: Path, sha: str = SHA, arch: str = "amd64", name: str = "img", extra_manifest: bool = False,
             tamper_layer: bool = False, media_type: str = "application/vnd.oci.image.manifest.v1+json") -> str:
    """Archivo OCI sintético como el de BuildKit (type=oci). Devuelve el digest del manifiesto."""
    layer = f"capa de {name}".encode()
    config = json.dumps({"os": "linux", "architecture": arch,
                         "config": {"User": "node", "Labels": {"org.opencontainers.image.revision": sha}}}).encode()
    layer_d = blob(layer, "application/vnd.oci.image.layer.v1.tar+gzip")
    config_d = blob(config, "application/vnd.oci.image.config.v1+json")
    manifest = json.dumps({"schemaVersion": 2, "mediaType": media_type, "config": config_d,
                           "layers": [layer_d]}).encode()
    manifest_d = blob(manifest, media_type)
    manifests = [manifest_d] + ([blob(b"{}", media_type)] if extra_manifest else [])
    index = json.dumps({"schemaVersion": 2, "manifests": manifests}).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w") as tar:
        _add(tar, "oci-layout", b'{"imageLayoutVersion":"1.0.0"}')
        _add(tar, "index.json", index)
        for data, d in ((manifest, manifest_d), (config, config_d), (layer + (b"X" if tamper_layer else b""), layer_d)):
            _add(tar, "blobs/sha256/" + d["digest"].split(":")[1], data)
    return manifest_d["digest"]


def make_release(tool, release: Path, sha: str = SHA) -> dict:
    """Las 9 imágenes sintéticas, images.json, informes de Trivy vacíos, SBOM e informes aprobados."""
    for image in tool.IMAGES:
        make_oci(release / tool.archive_name(image), sha=sha, name=image["name"])
    assert tool.main(["describe", str(release), "--sha", sha]) == 0
    (release / "scans").mkdir(exist_ok=True)
    (release / "sbom").mkdir(exist_ok=True)
    for image in tool.IMAGES:
        (release / "scans" / f"{image['name']}.trivy.json").write_text(json.dumps({"Results": []}))
        (release / "sbom" / f"{image['name']}.cdx.json").write_text(json.dumps({"components": [
            {"name": "core", "group": "@nestjs", "version": "11.0.0", "purl": "pkg:npm/%40nestjs/core@11.0.0",
             "properties": [{"name": "aquasecurity:trivy:FilePath", "value": "app/node_modules/@nestjs/core/package.json"}]}]}))
    for report in ("policy-report.json", "runtime-contents.json"):
        (release / report).write_text(json.dumps({"status": "pass", "excepted": []}))
    return json.loads((release / "images.json").read_text())
