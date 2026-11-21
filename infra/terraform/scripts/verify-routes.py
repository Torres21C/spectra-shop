#!/usr/bin/env python3
"""Contrasta el enrutamiento de CloudFront y del ALB (Terraform) con las rutas reales de los servicios.

Sin dependencias ni red. Lee:
  - los controladores NestJS (`@Controller`, `@Get`, `@Post`…) y los módulos que registra cada listener
    (`app.module.ts` = puerto público; `internal-app.module.ts` = puerto interno);
  - los comportamientos de CloudFront (`modules/edge/main.tf`, `api_behaviors`) y las reglas del ALB
    (`modules/alb/main.tf`, `rules`).

Comprueba:
  1. Cada ruta pública de negocio llega por CloudFront al ALB, con el método permitido, y el ALB la envía al
     servicio que la implementa.
  2. /health*, /docs* y todas las rutas internas NO se enrutan: CloudFront las sirve desde S3 (403) y el ALB
     responde con su 404 por defecto.
  3. Ninguna ruta interna está registrada en un listener público.
  4. Las rutas /admin de los listeners públicos tienen AdminAccessGuard.
  5. Cada patrón de CloudFront y del ALB corresponde al menos a una ruta real.
Sale con código 1 si algo no se cumple.
"""

from __future__ import annotations

import re
import sys
from fnmatch import fnmatchcase
from pathlib import Path

TF_ROOT = Path(__file__).resolve().parent.parent
REPO = TF_ROOT.parent.parent
SERVICES = ["identity", "catalog", "commerce", "audit"]
SAMPLE_PARAM = "00000000-0000-0000-0000-000000000000"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print(f"FAIL {message}")


def module_files(service: str) -> dict[str, Path]:
    """Clase de módulo → archivo."""
    result = {}
    for path in (REPO / f"apps/{service}-service/src").rglob("*.module.ts"):
        match = re.search(r"export class (\w+)", path.read_text())
        if match:
            result[match.group(1)] = path
    return result


def list_in(block_name: str, text: str) -> list[str]:
    match = re.search(block_name + r"\s*:\s*\[", text)
    if not match:
        return []
    depth, i = 1, match.end()
    while depth and i < len(text):
        depth += {"[": 1, "]": -1}.get(text[i], 0)
        i += 1
    body = re.sub(r"\([^()]*(\([^()]*\)[^()]*)*\)", "", text[match.end() : i - 1])
    return re.findall(r"\b([A-Z]\w+)\b", body)


def controllers_of(module_class: str, modules: dict[str, Path], seen: set[str]) -> set[str]:
    if module_class in seen or module_class not in modules:
        return set()
    seen.add(module_class)
    text = modules[module_class].read_text()
    found = set(list_in("controllers", text))
    for imported in list_in("imports", text):
        found |= controllers_of(imported, modules, seen)
    return found


def controller_routes(service: str) -> dict[str, list[tuple[str, str, bool]]]:
    """Clase de controlador → [(método, ruta, admin_guard)]."""
    result = {}
    for path in (REPO / f"apps/{service}-service/src").rglob("*.ts"):
        if path.name.endswith((".test.ts", ".spec.ts")):
            continue
        text = path.read_text()
        for match in re.finditer(r"@Controller\(\s*(?:'([^']*)')?\s*\)", text):
            prefix = match.group(1) or ""
            class_match = re.search(r"export class (\w+)", text[match.end() :])
            if not class_match:
                continue
            start = match.end() + class_match.end()
            nxt = re.search(r"@Controller\(", text[start:])
            body = text[start : start + nxt.start()] if nxt else text[start:]
            header = text[max(0, match.start() - 200) : match.end()]
            admin_guard = "AdminAccessGuard" in header
            routes = []
            for method, sub in re.findall(r"@(Get|Post|Patch|Delete|Put)\(\s*(?:'([^']*)')?\s*\)", body):
                full = "/" + "/".join(p for p in (prefix, sub) if p)
                routes.append((method.upper(), full, admin_guard))
            result[class_match.group(1)] = routes
    return result


def concrete(path: str) -> str:
    return re.sub(r":\w+", SAMPLE_PARAM, path)


def cloudfront_behaviors() -> list[tuple[str, list[str]]]:
    text = (TF_ROOT / "modules/edge/main.tf").read_text()
    methods = {
        "local.api_all_methods": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        "local.api_read_methods": ["GET", "HEAD", "OPTIONS"],
    }
    return [
        (path, methods[ref])
        for path, ref in re.findall(r'\{\s*path\s*=\s*"([^"]+)",\s*methods\s*=\s*(local\.\w+)\s*\}', text)
    ]


def alb_rules() -> list[tuple[int, str, list[str]]]:
    text = (TF_ROOT / "modules/alb/main.tf").read_text()
    rules = []
    for priority, service, paths in re.findall(
        r'priority\s*=\s*(\d+)\s*service\s*=\s*"(\w+)"\s*paths\s*=\s*\[([^\]]*)\]', text
    ):
        rules.append((int(priority), service, re.findall(r'"([^"]+)"', paths)))
    return sorted(rules)


def first_behavior(path: str, behaviors):
    for pattern, methods in behaviors:
        if fnmatchcase(path, pattern):
            return pattern, methods
    return None


def first_rule(path: str, rules):
    for priority, service, patterns in rules:
        if any(fnmatchcase(path, pattern) for pattern in patterns):
            return priority, service
    return None


def main() -> int:
    behaviors = cloudfront_behaviors()
    rules = alb_rules()
    if len(behaviors) != 10 or len(rules) != 5:
        fail(f"no se pudieron leer los patrones de Terraform ({len(behaviors)} comportamientos, {len(rules)} reglas)")
        return 1

    used_behaviors, used_rule_patterns = set(), set()
    public_count = internal_count = 0
    print(f"{'Servicio':9} {'Listener':8} {'Método':6} {'Ruta':45} {'CloudFront':14} {'ALB':10} Resultado")

    for service in SERVICES:
        modules = module_files(service)
        routes = controller_routes(service)
        public = controllers_of("AppModule", modules, set())
        internal = controllers_of("InternalAppModule", modules, set())

        for controller, entries in sorted(routes.items()):
            on_public = controller in public
            on_internal = controller in internal and not on_public
            if not on_public and not on_internal:
                continue
            for method, path, admin_guard in entries:
                url = concrete(path)
                behavior = first_behavior(url, behaviors)
                rule = first_rule(url, rules)
                cf = behavior[0] if behavior else "S3 (defecto)"
                alb = f"{rule[1]}:{rule[0]}" if rule else "404"
                listener = "público" if on_public else "interno"
                is_infra = path.startswith(("/health", "/docs"))

                if path.startswith("/internal") and on_public:
                    fail(f"{service}: ruta interna {path} registrada en el listener público")
                if on_public and not is_infra and not path.startswith("/internal"):
                    public_count += 1
                    ok = (
                        behavior is not None
                        and method in behavior[1]
                        and rule is not None
                        and rule[1] == service
                    )
                    if path.startswith("/admin") and not admin_guard:
                        ok = False
                        fail(f"{service}: {method} {path} sin AdminAccessGuard")
                    if not ok:
                        fail(f"{service}: {method} {path} mal enrutada (CloudFront {cf}, ALB {alb})")
                    if behavior:
                        used_behaviors.add(behavior[0])
                    if rule:
                        used_rule_patterns.update(p for p in next(r[2] for r in rules if r[0] == rule[0]) if fnmatchcase(url, p))
                    result = "OK enrutada" + (" (ADMIN)" if path.startswith("/admin") else "")
                else:
                    if not on_public:
                        internal_count += 1
                    ok = behavior is None and rule is None
                    if not ok:
                        fail(f"{service}: {method} {path} ({listener}) expuesta (CloudFront {cf}, ALB {alb})")
                    result = "OK no expuesta"
                print(f"{service:9} {listener:8} {method:6} {path:45} {cf:14} {alb:10} {result}")

        # Swagger (SwaggerModule.setup en main.ts, sin decoradores).
        main_ts = (REPO / f"apps/{service}-service/src/main.ts").read_text()
        if "SwaggerModule.setup('docs'" in main_ts:
            for path in ("/docs", "/docs-json"):
                behavior, rule = first_behavior(path, behaviors), first_rule(path, rules)
                status = "OK no expuesta" if behavior is None and rule is None else "EXPUESTA"
                if status != "OK no expuesta":
                    fail(f"{service}: Swagger {path} expuesto")
                print(f"{service:9} {'público':8} {'GET':6} {path + ' (Swagger)':45} {'S3 (defecto)' if not behavior else behavior[0]:14} {'404' if not rule else rule[1]:10} {status}")

    for pattern, _ in behaviors:
        if pattern not in used_behaviors:
            fail(f"comportamiento de CloudFront sin ruta real: {pattern}")
    for _, _, patterns in rules:
        for pattern in patterns:
            if pattern not in used_rule_patterns and not pattern.endswith("/*"):
                fail(f"patrón del ALB sin ruta real: {pattern}")

    print(
        f"\nRutas públicas de negocio enrutadas: {public_count}; rutas internas no expuestas: {internal_count}; "
        f"comportamientos de CloudFront: {len(behaviors)}; reglas del ALB: {len(rules)}"
    )
    print("Resultado:", "OK" if not failures else f"{len(failures)} fallo(s)")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
