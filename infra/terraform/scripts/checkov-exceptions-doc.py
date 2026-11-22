#!/usr/bin/env python3
"""Genera o comprueba docs/07-excepciones-checkov.md a partir de Checkov y de los comentarios del código.

Uso (desde infra/terraform):
  checkov -d . --framework terraform --skip-download -o json > /tmp/checkov.json
  python3 -I scripts/checkov-exceptions-doc.py generate /tmp/checkov.json docs/07-excepciones-checkov.md
  npx prettier --write docs/07-excepciones-checkov.md
  python3 -I scripts/checkov-exceptions-doc.py check /tmp/checkov.json docs/07-excepciones-checkov.md

La justificación de cada excepción se lee del comentario real `checkov:skip=<ID>:<texto>` dentro del bloque del
recurso: la salida JSON de Checkov 3.4.6 no la incluye. El script falla (código 1) si:
  - una excepción no tiene justificación en el código o la tiene vacía;
  - una excepción no tiene categoría asignada (cada excepción nueva exige clasificarla aquí);
  - Checkov informó de fallos o de errores de análisis;
  - en modo `check`, las tablas del documento no coinciden con el código (filas, categorías, estado o texto).
Sin dependencias externas; compatible con Python 3.9.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATE = "2026-11-21"
DATE_PR62 = "2026-11-22"

# Excepciones preventivas: Checkov no las detecta (retención por variable, registros del ALB por bloque
# dinámico), pero la configuración real sí se desvía. Revisadas con Checkov completo sin anotaciones.
PREVENTIVE = {
    ("CKV_AWS_338", "module.edge.aws_cloudwatch_log_group.waf"),
    ("CKV_AWS_338", "module.observability.aws_cloudwatch_log_group.workload"),
    ("CKV_AWS_91", "module.alb.aws_lb.this"),
}

COST = "Costo o alcance del laboratorio"
CATEGORIES = [
    (COST, "Sí"),
    ("Decisión de diseño (DT-09: roles con contraseña)", "Sí"),
    ("Decisión de diseño (HSTS sin preload)", "Sí"),
    ("Decisión de diseño (tareas DT-09 lanzadas con run-task)", "Sí"),
    ("Decisión pendiente §18.5 (dominio propio)", "Sí"),
    ("Decisión del propietario (AnonymousIpList en WAF)", "Sí"),
    ("Desviación de laboratorio C5", "Sí"),
    ("Decisión del propietario D6 (CloudTrail en lugar del registro de accesos)", "Sí"),
    ("Decisión de diseño (auditoría del state limitada a su bucket, PR-6.2)", "Sí"),
    ("Falso positivo (política de clave KMS)", "No"),
    ("Falso positivo (prefix list de CloudFront)", "No"),
    ("Falso positivo (SG asociado en otro módulo)", "No"),
]
CATEGORY_BY_ID = {
    **{i: COST for i in (
        "CKV2_AWS_57", "CKV2_AWS_62", "CKV_AWS_118", "CKV_AWS_144", "CKV_AWS_150", "CKV_AWS_157", "CKV_AWS_18",
        "CKV_AWS_310", "CKV_AWS_338", "CKV_AWS_353", "CKV_AWS_374", "CKV_AWS_65", "CKV_AWS_86", "CKV_AWS_91",
    )},
    "CKV_AWS_161": CATEGORIES[1][0],
    "CKV_AWS_259": CATEGORIES[2][0],
    "CKV_AWS_174": CATEGORIES[4][0],
    "CKV2_AWS_47": CATEGORIES[5][0],
    **{i: CATEGORIES[6][0] for i in ("CKV_AWS_2", "CKV_AWS_103", "CKV_AWS_378", "CKV2_AWS_20")},
    **{i: CATEGORIES[9][0] for i in ("CKV_AWS_109", "CKV_AWS_111", "CKV_AWS_356")},
    "CKV_AWS_260": CATEGORIES[10][0],
    "CKV2_AWS_5": CATEGORIES[11][0],
    **{i: COST for i in ("CKV_AWS_252", "CKV2_AWS_10")},
    "CKV_AWS_67": CATEGORIES[8][0],
}
CATEGORY_OVERRIDES = {
    ("CKV2_AWS_5", "module.security_groups.aws_security_group.ops"): CATEGORIES[3][0],
    ("CKV_AWS_18", "aws_s3_bucket.state"): CATEGORIES[7][0],
    ("CKV_AWS_18", "aws_s3_bucket.audit"): CATEGORIES[8][0],
}

# Origen respecto de la primera versión de PR-5 (32 excepciones obtenidas con un Checkov incompleto).
RESTORED_IDS = {"CKV2_AWS_57", "CKV2_AWS_62", "CKV_AWS_18", "CKV_AWS_144", "CKV_AWS_103"}
NEW_IDS = {"CKV2_AWS_5", "CKV_AWS_378", "CKV2_AWS_20", "CKV2_AWS_47"}
# Recursos añadidos en PR-6.2 (auditoría del state en el bootstrap).
PR62_RESOURCES = {"aws_s3_bucket.audit", "aws_cloudtrail.state_audit"}

# Decisiones del propietario del 2026-11-21 (ADR-AWS-05, «Aceptación del propietario»).
PENDING = {
    ("CKV_AWS_174", "module.edge.aws_cloudfront_distribution.this"): "Pendiente: resolver antes del despliegue (R-PR5-27)",
}
# Decisiones del propietario del 2026-11-22 (PR-6.2; ADR-AWS-05, D-AWS-05-18 a D-AWS-05-22).
ACCEPTED_D6 = f"Aceptada: R-PR5-26 cubierto por CloudTrail, que no equivale al registro de accesos ({DATE_PR62}, D6)"
ACCEPTED_PR62 = f"Aceptada para el laboratorio ({DATE_PR62}, PR-6.2)"
ACCEPTED_C5 = f"Aceptada temporalmente ({DATE}, ADR-AWS-05)"
ACCEPTED_47 = f"Aceptada: no bloquear; evaluar en modo Count ({DATE}, R-PR5-25)"
ACCEPTED = f"Aceptada para el laboratorio ({DATE})"
NOT_REQUIRED = "No requiere (falso positivo)"

ORDER = {name: i for i, (name, _) in enumerate(CATEGORIES)}
errors: list[str] = []


def load(path: str) -> dict:
    data = json.loads(Path(path).read_text())
    report = data[0] if isinstance(data, list) else data
    summary = report.get("summary", {})
    if summary.get("failed"):
        errors.append(f"Checkov informa {summary['failed']} fallos")
    if summary.get("parsing_errors"):
        errors.append(f"Checkov informa {summary['parsing_errors']} errores de análisis")
    return report


def justification(check_id: str, file_path: str, start: int, end: int) -> str:
    lines = (ROOT / file_path).read_text().splitlines()
    pattern = re.compile(r"#\s*checkov:skip=" + re.escape(check_id) + r":(.*)$")
    for line in lines[start - 1 : end]:
        match = pattern.search(line)
        if match:
            return match.group(1).strip()
    return ""


def rows(report: dict) -> list[dict]:
    result = []
    for check in report["results"]["skipped_checks"]:
        cid, res = check["check_id"], check["resource"]
        file_path = check["file_path"].lstrip("/")
        start, end = check["file_line_range"]
        text = justification(cid, file_path, start, end)
        if not text:
            errors.append(f"{cid} en {res} ({file_path}:{start}): justificación vacía o ausente en el código")
        category = CATEGORY_OVERRIDES.get((cid, res)) or CATEGORY_BY_ID.get(cid)
        if not category:
            errors.append(f"{cid} en {res}: sin categoría asignada en scripts/checkov-exceptions-doc.py")
            category = "SIN CATEGORÍA"
        if category.startswith("Falso positivo"):
            status = NOT_REQUIRED
        elif (cid, res) in PENDING:
            status = PENDING[(cid, res)]
        elif (cid, res) == ("CKV_AWS_18", "aws_s3_bucket.state"):
            status = ACCEPTED_D6
        elif res in PR62_RESOURCES:
            status = ACCEPTED_PR62
        elif category == CATEGORIES[6][0]:
            status = ACCEPTED_C5
        elif cid == "CKV2_AWS_47":
            status = ACCEPTED_47
        else:
            status = ACCEPTED
        if res in PR62_RESOURCES:
            origin = "PR-6.2"
        else:
            origin = "Nueva (CI)" if cid in NEW_IDS else "Restaurada" if cid in RESTORED_IDS else "PR-5 inicial"
        result.append({
            "id": cid + (" ◇" if (cid, res) in PREVENTIVE else ""),
            "resource": res,
            "location": f"{file_path}:{start}",
            "category": category,
            "status": status,
            "origin": origin,
            "justification": text.replace("|", "/"),
        })
    result.sort(key=lambda r: (ORDER.get(r["category"], 99), r["id"], r["resource"]))
    return result


def summary_rows(items: list[dict]) -> list[list[str]]:
    count = Counter(r["category"] for r in items)
    out = [[name, str(count[name]), needs] for name, needs in CATEGORIES]
    out.append(["**Total**", f"**{len(items)}**", ""])
    return out


def detail_rows(items: list[dict]) -> list[list[str]]:
    return [
        [str(i), r["id"], f"`{r['resource']}`", f"`{r['location']}`", r["category"], r["status"], r["origin"], r["justification"]]
        for i, r in enumerate(items, 1)
    ]


def table(header: list[str], body: list[list[str]]) -> list[str]:
    return ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"] + [
        "| " + " | ".join(row) + " |" for row in body
    ]


SUMMARY_HEADER = ["Categoría", "Nº", "¿Requiere aceptación del propietario?"]
DETAIL_HEADER = ["#", "ID", "Recurso", "Archivo:línea", "Categoría", "Estado", "Origen", "Justificación (del código)"]


def render(report: dict, items: list[dict]) -> str:
    s = report["summary"]
    status = Counter(r["status"] for r in items)
    accepted = sum(n for k, n in status.items() if k.startswith("Aceptada"))
    pending = sum(n for k, n in status.items() if k.startswith("Pendiente"))
    origin = Counter(r["origin"] for r in items)
    lines = [
        "# Excepciones de Checkov (PR-5 y PR-6.2)",
        "",
        "> [!NOTE]",
        "> Documento generado con `scripts/checkov-exceptions-doc.py` a partir de Checkov y de los comentarios `checkov:skip` del código. `scripts/static-checks.sh` (local y CI) comprueba que coincide con el código y que ninguna justificación está vacía. No se edita a mano.",
        "",
        f"- **Checkov {s['checkov_version']} completo** (imagen oficial fijada por digest en `scripts/ci/checkov-docker.sh`, la misma que usa la CI), framework terraform, sobre `infra/terraform`: **{s['passed']} superados, 0 fallidos y {len(items)} excepciones**, sin errores de análisis.",
        "- Cada excepción es un comentario `checkov:skip=<ID>:<justificación>` en el recurso. Revisión del 2026-11-21 con Checkov completo sobre una copia **sin ninguna anotación**: 54 fallos reales, todos cubiertos, más **3 excepciones preventivas** (◇), que Checkov no detecta porque la retención llega por variable o los registros del ALB por un bloque dinámico, aunque la configuración real sí se desvía.",
        "- **Corrección respecto de la primera versión (32 excepciones, 355 superados).** Aquel resultado se obtuvo con la fórmula de Homebrew de Checkov 3.4.6, que no incluye las comprobaciones de grafo. El primer job de IaC en la CI encontró 25 fallos más:",
        "  - **10 anotaciones restauradas** (11 excepciones; _Restaurada_) que `b62e968` había convertido en notas.",
        "  - **8 anotaciones nuevas** (14 excepciones; _Nueva (CI)_): CKV2_AWS_5, CKV_AWS_378, CKV2_AWS_20 y CKV2_AWS_47.",
        "  - Las otras 6 notas (CKV_AWS_354, CKV2_AWS_30, CKV_AWS_7, CKV2_AWS_28, CKV2_AWS_74 y CKV2_AWS_42) siguen sin fallar y se conservan como notas.",
        f"- **PR-6.2 ({DATE_PR62}):** el análisis cubre tres raíces (`bootstrap`, `publisher` y `environments/lab`). Los repositorios ECR y el rol publicador pasan a `publisher` sin excepciones nuevas. La auditoría del state añade {origin['PR-6.2']} excepciones en `bootstrap/audit.tf` (_PR-6.2_), una por cada fallo real de Checkov completo sobre el código sin anotar: ninguna preventiva.",
        "- Las excepciones equivalentes de Trivy están en `infra/terraform/.trivyignore.yaml`.",
        "",
        f"## Decisiones del propietario ({DATE} y {DATE_PR62})",
        "",
        f"- **{accepted} excepciones aceptadas** para el laboratorio académico, incluidas las de la desviación C5 (aceptada temporalmente con ADR-AWS-05) y CKV2_AWS_47 (no bloquear VPN ni proveedores de nube; evaluar `AWSManagedRulesAnonymousIpList` en modo Count durante el laboratorio, sin añadirla todavía al WAF).",
        "- **CKV_AWS_18 del bucket del state (R-PR5-26):** deja de estar pendiente. Se mantiene como excepción justificada (D6): los accesos a los objetos del state los registra el trail `spectra-tfstate-audit` con eventos de datos de CloudTrail. **No son controles idénticos:** CloudTrail registra la identidad IAM y la API, con entrega garantizada y validación de integridad, pero no reproduce el formato ni todos los campos del registro de accesos de S3.",
        f"- **{origin['PR-6.2']} excepciones de PR-6.2** (bucket de auditoría y trail limitado al state), aceptadas con las decisiones D5, D6 y D8 del {DATE_PR62}.",
        f"- **{pending} pendiente**, que no bloquea el merge pero sí la ejecución:",
        "  - CKV_AWS_174 de CloudFront: **resolver antes del despliegue**; preferencia del propietario: dominio propio con TLS mínimo 1.2 si es viable (R-PR5-27).",
        f"- **{status[NOT_REQUIRED]} falsos positivos**, que no requieren aceptación.",
        "",
    ]
    lines += table(SUMMARY_HEADER, summary_rows(items))
    lines += ["", f"Origen de las {len(items)} excepciones: {origin['PR-5 inicial']} de la primera versión de PR-5, {origin['Restaurada']} restauradas, {origin['Nueva (CI)']} nuevas de la CI de PR-5 y {origin['PR-6.2']} de PR-6.2.", ""]
    lines += table(DETAIL_HEADER, detail_rows(items))
    return "\n".join(lines) + "\n"


def parse_tables(text: str) -> list[list[list[str]]]:
    tables, current = [], []
    for line in text.splitlines():
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
                current.append(cells)
        elif current:
            tables.append(current)
            current = []
    if current:
        tables.append(current)
    return tables


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in ("generate", "check"):
        print(__doc__)
        return 2
    mode, checkov_json, doc = sys.argv[1:]
    report = load(checkov_json)
    items = rows(report)
    if errors:
        for e in errors:
            print("FAIL", e)
        return 1
    if mode == "generate":
        Path(doc).write_text(render(report, items))
        print(f"Generado {doc}: {len(items)} excepciones, todas con justificación.")
        return 0
    expected = [[SUMMARY_HEADER] + summary_rows(items), [DETAIL_HEADER] + detail_rows(items)]
    actual = parse_tables(Path(doc).read_text())
    if actual != expected:
        print(f"FAIL {doc} no coincide con el código: regenerarlo con scripts/checkov-exceptions-doc.py generate")
        for want, got in zip([r for t in expected for r in t], [r for t in actual for r in t]):
            if want != got:
                print("  esperado:", " | ".join(want)[:200])
                print("  actual:  ", " | ".join(got)[:200])
                break
        return 1
    print(f"OK   {doc} coincide con el código: {len(items)} excepciones, todas con justificación.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
