"""Pruebas positivas y negativas del guard de planes de lab; solo archivos temporales, sin Terraform ni AWS.

El plan binario se construye con el mismo formato que Terraform 1.17.2 (ZIP con `tfplan` protobuf y
`tfstate`). Las pruebas «golden» usan bytes copiados de planes reales generados localmente con el proveedor
random y backend local (sin AWS) para que el codificador de las pruebas no valide al decodificador por simetría.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.tests.helpers import load_tool

guard = load_tool("lab_teardown_guard", "infra/terraform/scripts/lab_teardown_guard.py")

CYCLE = "20261122-a"
NEXT_CYCLE = "20261122-b"
LINEAGE = "11111111-1111-4111-8111-111111111111"


# --- Codificadores mínimos del formato del plan binario ---------------------------------------------------


def pb_varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def pb_field(number: int, payload) -> bytes:
    if isinstance(payload, int):
        return pb_varint(number << 3) + pb_varint(payload)
    if isinstance(payload, str):
        payload = payload.encode()
    return pb_varint(number << 3 | 2) + pb_varint(len(payload)) + payload


def mp(value) -> bytes:
    if value is None:
        return b"\xc0"
    if value is True:
        return b"\xc3"
    if value is False:
        return b"\xc2"
    if isinstance(value, int):
        if 0 <= value <= 0x7F:
            return bytes([value])
        if 0 <= value <= 0xFFFF:
            return b"\xcd" + value.to_bytes(2, "big")
        return b"\xd3" + value.to_bytes(8, "big", signed=True)
    if isinstance(value, bytes):
        return b"\xc4" + bytes([len(value)]) + value
    if isinstance(value, str):
        raw = value.encode()
        if len(raw) <= 31:
            return bytes([0xA0 | len(raw)]) + raw
        return b"\xd9" + bytes([len(raw)]) + raw
    if isinstance(value, list):
        return bytes([0x90 | len(value)]) + b"".join(mp(item) for item in value)
    if isinstance(value, dict):
        return bytes([0x80 | len(value)]) + b"".join(mp(k) + mp(v) for k, v in value.items())
    raise TypeError(value)


def build_tfplan(spec: dict) -> bytes:
    out = pb_field(1, spec["format"])
    for name, value in spec["variables"].items():
        dynamic = pb_field(1, mp([b'"string"', value]))
        out += pb_field(2, pb_field(1, name) + pb_field(2, dynamic))
    for address in spec["changes"]:
        out += pb_field(3, pb_field(13, address))
    for name in spec["outputs"]:
        out += pb_field(4, pb_field(1, name))
    for target in spec["targets"]:
        out += pb_field(5, target)
    backend = spec["backend"]
    out += pb_field(
        13,
        pb_field(1, backend["type"]) + pb_field(2, pb_field(1, mp(backend["config"]))) + pb_field(3, backend["workspace"]),
    )
    out += pb_field(14, spec["terraform_version"])
    if spec["destroy"]:
        out += pb_field(17, 1)
    if spec["complete"]:
        out += pb_field(26, 1)
    return out


def change(address, before, after, actions=None, module=None, rtype=None):
    return {
        "address": address,
        "module_address": module or address.split(".aws_")[0],
        "mode": "managed",
        "type": rtype or "aws_" + address.split(".aws_")[1].split(".")[0],
        "change": {"actions": actions or ["update"], "before": before, "after": after},
    }


def resource(module, rtype, name, keys=(None,)):
    instances = [{} if key is None else {"index_key": key} for key in keys]
    return {"module": module, "mode": "managed", "type": rtype, "name": name, "instances": instances}


class LabPlanGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.mode = "prepare"
        self.binary_tweaks = []
        self.sha_override = None
        self.keep_json_prior = False
        self.identity = {
            "workspace": "default",
            "lineage": LINEAGE,
            "minimum_serial": 4,
            "lab_cycle_id": CYCLE,
            "backend": {
                "bucket": "spectra-tfstate-111122223333-us-east-1",
                "key": "spectra-shop/lab/terraform.tfstate",
                "region": "us-east-1",
                "kms_key_id": "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
            },
        }
        self.metadata = {
            "backend": {
                "type": "s3",
                "config": {**self.identity["backend"], "workspace_key_prefix": None},
            }
        }
        self.state = {
            "version": 4,
            "terraform_version": "1.17.2",
            "serial": 7,
            "lineage": LINEAGE,
            "outputs": {"lab_cycle_id": {"value": CYCLE, "type": "string"}},
            "resources": [
                resource("module.database", "aws_db_instance", "this"),
                resource("module.edge", "aws_s3_bucket", "spa"),
                resource("module.ecs", "aws_ecs_service", "this", ["identity"]),
                {"mode": "data", "type": "aws_caller_identity", "name": "current", "instances": [{}]},
            ],
        }
        self.plan = self.common(
            {
                "prior_state": {"values": {"outputs": {"lab_cycle_id": {"value": CYCLE}}}},
                "planned_values": {"outputs": {"lab_cycle_id": {"value": CYCLE}}},
                "resource_changes": [
                    change(
                        "module.database.aws_db_instance.this",
                        {"deletion_protection": True},
                        {"deletion_protection": False},
                    ),
                    change("module.edge.aws_s3_bucket.spa", {"force_destroy": False}, {"force_destroy": True}),
                    change('module.ecs.aws_ecs_service.this["identity"]', {"desired_count": 1}, {"desired_count": 0}),
                ],
                "output_changes": {"teardown_mode": {"actions": ["update"], "before": False, "after": True}},
            }
        )
        self.write_all()

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def common(plan, cycle=CYCLE):
        return {
            "format_version": "1.2",
            "terraform_version": "1.17.2",
            "variables": {"lab_cycle_id": {"value": cycle}},
            "complete": True,
            "errored": False,
            **plan,
        }

    # --- Escritura de artefactos ------------------------------------------------------------------------

    def json_prior_root(self):
        modules: dict[str, list] = {}
        root = []
        for address in sorted(guard.state_managed_addresses(self.state)):
            entry = {"address": address, "mode": "managed"}
            if address.startswith("module."):
                modules.setdefault(".".join(address.split(".")[:2]), []).append(entry)
            else:
                root.append(entry)
        return {
            "resources": root,
            "child_modules": [{"address": name, "resources": items} for name, items in sorted(modules.items())],
        }

    def binary_spec(self):
        embedded = (
            copy.deepcopy(self.state)
            if self.state is not None
            else {"version": 4, "terraform_version": "1.17.2", "serial": 0, "lineage": "", "outputs": {}, "resources": []}
        )
        spec = {
            "format": 3,
            "variables": {name: entry["value"] for name, entry in self.plan.get("variables", {}).items()},
            "changes": [c["address"] for c in self.plan.get("resource_changes", []) if isinstance(c, dict)],
            "outputs": list(self.plan.get("output_changes", {}) or {}),
            "targets": [],
            "backend": {
                "type": "s3",
                "workspace": "default",
                "config": {**self.identity["backend"], "encrypt": True, "use_lockfile": True, "workspace_key_prefix": None},
            },
            "terraform_version": "1.17.2",
            "destroy": self.mode == "destroy",
            "complete": True,
            "embedded": embedded,
        }
        for tweak in self.binary_tweaks:
            tweak(spec)
        return spec

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def write_all(self):
        if not self.keep_json_prior and isinstance(self.plan.get("prior_state"), dict):
            self.plan["prior_state"].setdefault("values", {})["root_module"] = self.json_prior_root()
        self.write("identity.json", self.identity)
        self.write("metadata.json", self.metadata)
        (self.root / "state.json").write_text("" if self.state is None else json.dumps(self.state))
        self.write("plan.json", self.plan)
        spec = self.binary_spec()
        with zipfile.ZipFile(self.root / "plan.tfplan", "w") as archive:
            archive.writestr("tfplan", build_tfplan(spec))
            archive.writestr("tfstate", json.dumps(spec["embedded"]))
            archive.writestr("tfstate-prev", json.dumps(spec["embedded"]))
        self.sha = hashlib.sha256((self.root / "plan.tfplan").read_bytes()).hexdigest()

    def args(self):
        return argparse.Namespace(
            mode=self.mode,
            identity=self.root / "identity.json",
            backend_metadata=self.root / "metadata.json",
            workspace_file=self.root / "environment",
            state=self.root / "state.json",
            plan=self.root / "plan.json",
            plan_file=self.root / "plan.tfplan",
            plan_sha256=self.sha_override if self.sha_override is not None else self.sha,
        )

    def assertRejected(self, fragment):
        self.write_all()
        with self.assertRaisesRegex(guard.GuardError, fragment):
            guard.verify(self.args())

    def assertAccepted(self, kind):
        self.write_all()
        self.assertEqual(guard.verify(self.args()), kind)

    # ---- Preparación: caso base y allowlist (F-03) -----------------------------------------------------

    def test_accepts_exact_backend_state_cycle_and_allowlist(self):
        self.assertAccepted("preparación del apagado")

    def test_rejects_wrong_backend_key(self):
        self.metadata["backend"]["config"]["key"] = "spectra-shop/publisher/terraform.tfstate"
        self.assertRejected("backend inicializado")

    def test_rejects_non_default_workspace(self):
        (self.root / "environment").write_text("demo")
        self.assertRejected("workspace activo")

    def test_rejects_wrong_state_lineage(self):
        self.state["lineage"] = "22222222-2222-4222-8222-222222222222"
        self.assertRejected("lineage")

    def test_rejects_cycle_change_on_active_state(self):
        self.plan["planned_values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("cambiar lab_cycle_id")

    def test_rejects_publisher_resource_in_state(self):
        self.state["resources"].append(resource("module.registry", "aws_ecr_repository", "this"))
        self.assertRejected("recurso persistente prohibido")

    def test_rejects_bootstrap_resource_in_state(self):
        self.state["resources"].append(resource(None, "aws_s3_bucket", "state"))
        self.assertRejected("recurso persistente prohibido")

    def test_rejects_change_outside_allowlist(self):
        self.plan["resource_changes"].append(
            change('module.endpoints.aws_vpc_endpoint.interface["kms"]', {"tags": {"x": "a"}}, {"tags": {"x": "b"}})
        )
        self.assertRejected("fuera de allowlist")

    def test_rejects_extra_attribute_on_allowed_resource(self):
        self.plan["resource_changes"][0]["change"]["before"]["instance_class"] = "db.t4g.micro"
        self.plan["resource_changes"][0]["change"]["after"]["instance_class"] = "db.t4g.small"
        self.assertRejected("atributos no permitidos")

    def test_rejects_replace_or_delete(self):
        self.plan["resource_changes"][0]["change"]["actions"] = ["delete", "create"]
        self.assertRejected("acción no permitida")

    def test_rejects_missing_required_transition(self):
        self.plan["resource_changes"] = self.plan["resource_changes"][1:]
        self.assertRejected("cambios obligatorios")

    # ---- Identidad del backend, workspace y state (F-04) ------------------------------------------------

    def test_rejects_identity_with_non_default_workspace(self):
        self.identity["workspace"] = "demo"
        self.assertRejected("workspace debe ser default")

    def test_rejects_wrong_backend_bucket(self):
        self.metadata["backend"]["config"]["bucket"] = "otro-bucket-de-state"
        self.assertRejected("bucket=")

    def test_rejects_wrong_backend_kms_key(self):
        self.metadata["backend"]["config"]["kms_key_id"] = "arn:aws:kms:us-east-1:111122223333:key/otra"
        self.assertRejected("kms_key_id=")

    def test_rejects_wrong_backend_region(self):
        self.metadata["backend"]["config"]["region"] = "us-west-2"
        self.assertRejected("region=")

    def test_rejects_non_s3_backend(self):
        self.metadata["backend"]["type"] = "local"
        self.assertRejected("type=s3")

    def test_rejects_custom_workspace_key_prefix(self):
        self.metadata["backend"]["config"]["workspace_key_prefix"] = "otro:"
        self.assertRejected("workspace_key_prefix")

    def test_rejects_identity_pointing_to_publisher_key(self):
        publisher = "spectra-shop/publisher/terraform.tfstate"
        self.identity["backend"]["key"] = publisher
        self.metadata["backend"]["config"]["key"] = publisher
        self.assertRejected("no corresponden a environments/lab")

    def test_rejects_identity_without_minimum_serial(self):
        del self.identity["minimum_serial"]
        self.assertRejected("minimum_serial")

    def test_rejects_identity_without_backend(self):
        self.write_all()
        del self.identity["backend"]
        self.write("identity.json", self.identity)
        with self.assertRaisesRegex(guard.GuardError, "falta backend"):
            guard.verify(self.args())

    def test_rejects_identity_with_invalid_cycle(self):
        self.identity["lab_cycle_id"] = "Cycle_2026!"
        self.assertRejected("lab_cycle_id ausente o inválido")

    def test_rejects_state_older_than_approved_serial(self):
        self.state["serial"] = 3
        self.assertRejected("serial anterior")

    def test_rejects_state_with_other_cycle(self):
        self.state["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("state remoto: lab_cycle_id")

    def test_rejects_root_resource_outside_lab_modules(self):
        self.state["resources"].append(resource(None, "aws_iam_role", "publisher"))
        self.assertRejected("fuera de lab")

    def test_rejects_empty_state(self):
        self.state["resources"] = []
        self.assertRejected("no contiene recursos activos")

    def test_prepare_rejects_absent_state(self):
        self.state = None
        self.assertRejected("solo el primer despliegue admite un state vacío")

    def test_rejects_plan_for_another_state(self):
        self.state["resources"][2]["instances"] = [{"index_key": "catalog"}]
        self.assertRejected("no corresponde al state")

    # ---- Preparación: ciclo, valores finales y outputs (F-03, F-07) --------------------------------------

    def test_rejects_prepare_plan_without_prior_cycle(self):
        del self.plan["prior_state"]["values"]["outputs"]["lab_cycle_id"]
        self.assertRejected("prior_state no coincide")

    def test_rejects_prepare_plan_from_other_cycle(self):
        self.plan["prior_state"]["values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.plan["planned_values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("prior_state no coincide")

    def test_rejects_rds_protection_being_enabled(self):
        self.plan["resource_changes"][0]["change"]["before"]["deletion_protection"] = False
        self.plan["resource_changes"][0]["change"]["after"]["deletion_protection"] = True
        self.assertRejected("deletion_protection=false")

    def test_rejects_spa_force_destroy_being_disabled(self):
        self.plan["resource_changes"][1]["change"]["before"]["force_destroy"] = True
        self.plan["resource_changes"][1]["change"]["after"]["force_destroy"] = False
        self.assertRejected("force_destroy=true")

    def test_rejects_ecs_scale_up_during_prepare(self):
        self.plan["resource_changes"][2]["change"]["after"]["desired_count"] = 2
        self.assertRejected("desired_count=0")

    def test_accepts_alb_protection_removal(self):
        self.state["resources"].append(resource("module.alb", "aws_lb", "this"))
        self.plan["resource_changes"].append(
            change("module.alb.aws_lb.this", {"enable_deletion_protection": True}, {"enable_deletion_protection": False})
        )
        self.assertAccepted("preparación del apagado")

    def test_rejects_alb_protection_being_enabled(self):
        self.state["resources"].append(resource("module.alb", "aws_lb", "this"))
        self.plan["resource_changes"].append(
            change("module.alb.aws_lb.this", {"enable_deletion_protection": False}, {"enable_deletion_protection": True})
        )
        self.assertRejected("enable_deletion_protection=false")

    def test_rejects_output_change_outside_allowlist(self):
        self.plan["output_changes"]["secret_names"] = {"actions": ["update"], "before": [], "after": ["x"]}
        self.assertRejected("output modificado fuera de allowlist")

    def test_rejects_teardown_output_set_back_to_false(self):
        self.plan["output_changes"]["teardown_mode"] = {"actions": ["update"], "before": True, "after": False}
        self.assertRejected("output modificado fuera de allowlist")

    def test_cli_rejects_malformed_json_without_traceback(self):
        self.write_all()
        self.plan["prior_state"] = None
        self.write("plan.json", self.plan)
        args = self.args()
        argv = [
            "--mode", "prepare",
            "--identity", str(args.identity),
            "--backend-metadata", str(args.backend_metadata),
            "--workspace-file", str(args.workspace_file),
            "--state", str(args.state),
            "--plan", str(args.plan),
            "--plan-file", str(args.plan_file),
            "--plan-sha256", args.plan_sha256,
        ]
        self.assertEqual(guard.main(argv), 1)

    def test_cli_accepts_valid_plan(self):
        self.write_all()
        args = self.args()
        argv = [
            "--mode", "prepare",
            "--identity", str(args.identity),
            "--backend-metadata", str(args.backend_metadata),
            "--workspace-file", str(args.workspace_file),
            "--state", str(args.state),
            "--plan", str(args.plan),
            "--plan-file", str(args.plan_file),
            "--plan-sha256", args.plan_sha256.upper(),
        ]
        self.assertEqual(guard.main(argv), 0)

    # ---- Vinculación plan binario ↔ JSON ↔ state (F-04, F-07) -------------------------------------------

    def tweak(self, function):
        self.binary_tweaks.append(function)

    def test_rejects_binary_with_unapproved_sha(self):
        self.sha_override = "0" * 64
        self.assertRejected("SHA-256 distinto del aprobado")

    def test_rejects_missing_or_malformed_sha(self):
        self.sha_override = "abc"
        self.assertRejected("SHA-256 aprobado del plan binario ausente o inválido")

    def test_rejects_binary_with_other_cycle_than_json(self):
        self.tweak(lambda s: s["variables"].update(lab_cycle_id=NEXT_CYCLE))
        self.assertRejected("no coinciden en la variable lab_cycle_id")

    def test_rejects_binary_without_cycle_variable(self):
        self.tweak(lambda s: s["variables"].pop("lab_cycle_id"))
        self.assertRejected("falta la variable lab_cycle_id")

    def test_rejects_binary_with_different_resource_changes(self):
        self.tweak(lambda s: s["changes"].append('module.ecs.aws_ecs_service.this["catalog"]'))
        self.assertRejected("mismos cambios de recursos")

    def test_binary_data_source_reads_are_not_managed_changes(self):
        self.tweak(lambda s: s["changes"].append("module.ecs.data.aws_iam_policy_document.task"))
        self.assertAccepted("preparación del apagado")

    def test_rejects_binary_with_different_outputs(self):
        self.tweak(lambda s: s["outputs"].append("secret_names"))
        self.assertRejected("mismos outputs")

    def test_rejects_binary_generated_against_other_lineage(self):
        self.tweak(lambda s: s["embedded"].update(lineage="22222222-2222-4222-8222-222222222222"))
        self.assertRejected("generado contra otro state")

    def test_rejects_stale_binary_serial(self):
        self.tweak(lambda s: s["embedded"].update(serial=6))
        self.assertRejected("generado contra otro state")

    def test_rejects_binary_embedded_resources_from_other_state(self):
        self.tweak(lambda s: s["embedded"]["resources"].pop(0))
        self.assertRejected("state previo embebido no corresponde")

    def test_rejects_json_prior_state_from_other_state(self):
        self.write_all()
        self.plan["prior_state"]["values"]["root_module"]["child_modules"].pop(0)
        self.keep_json_prior = True
        self.assertRejected("prior_state no corresponde")

    def test_rejects_binary_backend_bucket(self):
        self.tweak(lambda s: s["backend"]["config"].update(bucket="otro-bucket"))
        self.assertRejected("plan binario: backend: bucket=")

    def test_rejects_binary_backend_key_of_publisher(self):
        self.tweak(lambda s: s["backend"]["config"].update(key="spectra-shop/publisher/terraform.tfstate"))
        self.assertRejected("plan binario: backend: key=")

    def test_rejects_binary_backend_type(self):
        self.tweak(lambda s: s["backend"].update(type="local"))
        self.assertRejected("backend distinto de s3")

    def test_rejects_binary_workspace(self):
        self.tweak(lambda s: s["backend"].update(workspace="demo"))
        self.assertRejected("plan binario: workspace distinto")

    def test_rejects_binary_target_plan(self):
        self.tweak(lambda s: s["targets"].append("module.database"))
        self.assertRejected("plan parcial")

    def test_rejects_binary_incomplete_plan(self):
        self.tweak(lambda s: s.update(complete=False))
        self.assertRejected("plan parcial")

    def test_rejects_json_incomplete_plan(self):
        self.plan["complete"] = False
        self.assertRejected("plan parcial")

    def test_rejects_json_without_complete_flag(self):
        del self.plan["complete"]
        self.assertRejected("plan parcial")

    def test_rejects_errored_json_plan(self):
        self.plan["errored"] = True
        self.assertRejected("generado con errores")

    def test_rejects_destroy_binary_in_prepare_mode(self):
        self.tweak(lambda s: s.update(destroy=True))
        self.assertRejected("modo de plan")

    def test_rejects_other_terraform_version_in_binary(self):
        self.tweak(lambda s: s.update(terraform_version="1.18.0"))
        self.assertRejected("plan binario: Terraform")

    def test_rejects_other_terraform_version_in_json(self):
        self.plan["terraform_version"] = "1.18.0"
        self.assertRejected("plan JSON: Terraform")

    def test_rejects_unverified_plan_format(self):
        self.tweak(lambda s: s.update(format=4))
        self.assertRejected("formato 4 no verificado")

    def test_rejects_non_zip_plan_file(self):
        self.write_all()
        (self.root / "plan.tfplan").write_bytes(b"no es un plan")
        self.sha_override = hashlib.sha256(b"no es un plan").hexdigest()
        with self.assertRaisesRegex(guard.GuardError, "plan binario ilegible"):
            guard.verify(self.args())

    def test_rejects_plan_zip_without_embedded_state(self):
        self.write_all()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("tfplan", b"")
        (self.root / "plan.tfplan").write_bytes(buffer.getvalue())
        self.sha_override = hashlib.sha256(buffer.getvalue()).hexdigest()
        with self.assertRaisesRegex(guard.GuardError, "falta tfstate"):
            guard.verify(self.args())

    # ---- Formato real de Terraform 1.17.2 (bytes de planes generados localmente) -----------------------

    def test_golden_variable_encoding_from_terraform(self):
        entry = guard.pb_fields(b"\n\x0clab_cycle_id\x12\x18\n\x16\x92\xc4\x08\"string\"\xaa20261122-a")
        self.assertEqual(entry[0][2], b"lab_cycle_id")
        self.assertEqual(guard.dynamic_value(entry[1][2], wrapped=True), "20261122-a")

    def test_golden_backend_encoding_from_terraform(self):
        backend = guard.pb_fields(b"\n\x05local\x12\x18\n\x16\x82\xa4path\xc0\xadworkspace_dir\xc0\x1a\x07default")
        self.assertEqual(backend[0][2], b"local")
        self.assertEqual(guard.dynamic_value(backend[1][2], wrapped=False), {"path": None, "workspace_dir": None})
        self.assertEqual(backend[2][2], b"default")

    def test_golden_target_and_complete_fields(self):
        targeted = guard.pb_fields(pb_field(1, 3) + b"\x2a\x0brandom_id.a")
        self.assertIn((5, 2, b"random_id.a"), targeted)
        self.assertIn((26, 0, 1), guard.pb_fields(b"\xd0\x01\x01"))
        self.assertIn((17, 0, 1), guard.pb_fields(b"\x88\x01\x01"))

    def test_msgpack_rejects_unknown_values_and_trailing_bytes(self):
        with self.assertRaisesRegex(guard.GuardError, "no verificable"):
            guard.msgpack(b"\xd4\x00\x00")
        with self.assertRaisesRegex(guard.GuardError, "bytes sobrantes"):
            guard.msgpack(b"\xc0\xc0")
        with self.assertRaisesRegex(guard.GuardError, "truncado"):
            guard.msgpack(b"\xa5ab")

    def test_msgpack_decodes_supported_types(self):
        value = {"s": "x" * 40, "n": 300, "neg": -3, "big": -(2**40), "l": [True, False, None], "b": b"\x01"}
        self.assertEqual(guard.msgpack(mp(value)), value)

    def test_protobuf_rejects_truncated_fields(self):
        with self.assertRaisesRegex(guard.GuardError, "campo truncado"):
            guard.pb_fields(b"\x0a\x05ab")
        with self.assertRaisesRegex(guard.GuardError, "varint truncado"):
            guard.pb_fields(b"\x08\x80")

    def test_variable_without_cty_type_wrapper_is_rejected(self):
        with self.assertRaisesRegex(guard.GuardError, "sin tipo dinámico"):
            guard.dynamic_value(pb_field(1, mp("20261122-a")), wrapped=True)

    def test_explicit_false_complete_flag_is_incomplete(self):
        tfplan = build_tfplan({**self.binary_spec(), "complete": False}) + pb_field(26, 0)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("tfplan", tfplan)
            archive.writestr("tfstate", json.dumps(self.state))
        (self.root / "explicit.tfplan").write_bytes(buffer.getvalue())
        self.assertFalse(guard.read_plan_file(self.root / "explicit.tfplan")["complete"])

    # ---- Despliegue normal y actualización (F-07) -------------------------------------------------------

    def deploy_update(self):
        """State activo del ciclo aprobado; el plan escala ECS a 1 y añade una regla de ingreso."""
        self.mode = "deploy"
        self.plan = self.common(
            {
                "prior_state": {"values": {"outputs": {"lab_cycle_id": {"value": CYCLE}}}},
                "planned_values": {
                    "outputs": {"lab_cycle_id": {"value": CYCLE}, "teardown_mode": {"value": False}}
                },
                "resource_changes": [
                    change("module.database.aws_db_instance.this", {}, {}, ["no-op"]),
                    change("module.edge.aws_s3_bucket.spa", {}, {}, ["no-op"]),
                    change('module.ecs.aws_ecs_service.this["identity"]', {"desired_count": 0}, {"desired_count": 1}),
                    change(
                        "module.security_groups.aws_vpc_security_group_ingress_rule.alb_vpc_origin[0]",
                        None,
                        {},
                        ["create"],
                    ),
                ],
                "output_changes": {
                    "lab_cycle_id": {"actions": ["no-op"], "before": CYCLE, "after": CYCLE},
                    "teardown_mode": {"actions": ["no-op"], "before": False, "after": False},
                },
            }
        )

    def deploy_first(self, retained=False):
        """Primer despliegue de un ciclo nuevo: sin state o con el state conservado vacío tras un destroy."""
        self.mode = "deploy"
        self.identity["lab_cycle_id"] = NEXT_CYCLE
        if retained:
            self.state = {"version": 4, "serial": 12, "lineage": LINEAGE, "outputs": {}, "resources": []}
            self.identity["minimum_serial"] = 12
        else:
            self.state = None
            self.identity["lineage"] = None
            self.identity["minimum_serial"] = 0
        self.plan = self.common(
            {
                "prior_state": {"values": {"outputs": {"lab_cycle_id": {"value": NEXT_CYCLE}}}},
                "planned_values": {
                    "outputs": {"lab_cycle_id": {"value": NEXT_CYCLE}, "teardown_mode": {"value": False}}
                },
                "resource_changes": [
                    change("module.database.aws_db_instance.this", None, {}, ["create"]),
                    change('module.secrets.aws_secretsmanager_secret.token["internal"]', None, {}, ["create"]),
                    change("module.kms.aws_kms_key.data", None, {}, ["create"]),
                ],
                "output_changes": {
                    "lab_cycle_id": {"actions": ["create"], "before": None, "after": NEXT_CYCLE},
                    "teardown_mode": {"actions": ["create"], "before": None, "after": False},
                },
            },
            cycle=NEXT_CYCLE,
        )

    def test_deploy_accepts_first_deployment_without_state(self):
        self.deploy_first()
        self.assertAccepted("primer despliegue")

    def test_deploy_accepts_first_deployment_on_retained_empty_state(self):
        self.deploy_first(retained=True)
        self.assertAccepted("primer despliegue")

    def test_deploy_first_rejects_identity_lineage_without_state(self):
        self.deploy_first()
        self.identity["lineage"] = LINEAGE
        self.assertRejected("registra un lineage, pero no hay state")

    def test_deploy_first_rejects_retained_state_with_other_lineage(self):
        self.deploy_first(retained=True)
        self.identity["lineage"] = "22222222-2222-4222-8222-222222222222"
        self.assertRejected("lineage distinto del aprobado")

    def test_deploy_first_rejects_retained_state_without_identity_lineage(self):
        self.deploy_first(retained=True)
        self.identity["lineage"] = None
        self.assertRejected("lineage distinto del aprobado")

    def test_deploy_first_rejects_retained_state_older_than_approved(self):
        self.deploy_first(retained=True)
        self.identity["minimum_serial"] = 13
        self.assertRejected("serial anterior al aprobado")

    def test_deploy_first_rejects_plan_generated_against_existing_state(self):
        self.deploy_first()
        self.tweak(lambda s: s["embedded"].update(lineage=LINEAGE, serial=7))
        self.assertRejected("generado contra un state existente")

    def test_deploy_first_rejects_non_create_actions(self):
        self.deploy_first()
        self.plan["resource_changes"][0]["change"]["actions"] = ["update"]
        self.assertRejected("el primer despliegue solo crea recursos")

    def test_deploy_first_rejects_cycle_other_than_identity(self):
        self.deploy_first()
        self.identity["lab_cycle_id"] = CYCLE
        self.assertRejected("lab_cycle_id del plan no coincide con la identidad")

    def test_deploy_first_rejects_publisher_resource(self):
        self.deploy_first()
        self.plan["resource_changes"].append(
            change('module.registry.aws_ecr_repository.this["identity-service"]', None, {}, ["create"])
        )
        self.assertRejected("recurso persistente prohibido")

    def test_deploy_rejects_unknown_module(self):
        self.deploy_first()
        self.plan["resource_changes"].append(
            change("module.publisher.aws_iam_role.github", None, {}, ["create"])
        )
        self.assertRejected("fuera de los módulos de lab")

    def test_deploy_accepts_update_of_same_cycle(self):
        self.deploy_update()
        self.assertAccepted("actualización del mismo ciclo")

    def test_deploy_rejects_accidental_cycle_change(self):
        self.deploy_update()
        self.plan["variables"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.plan["planned_values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("cambiar lab_cycle_id sobre un state activo")

    def test_deploy_rejects_cycle_change_only_in_binary(self):
        self.deploy_update()
        self.plan["variables"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("cambiar lab_cycle_id sobre un state activo")

    def test_deploy_rejects_cycle_change_only_in_planned_outputs(self):
        # Configuración manipulada: la variable conserva el ciclo, pero el output (y los nombres) cambian.
        self.deploy_update()
        self.plan["planned_values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("cambiar lab_cycle_id sobre un state activo")

    def test_deploy_rejects_cycle_change_even_with_updated_identity(self):
        self.deploy_update()
        self.identity["lab_cycle_id"] = NEXT_CYCLE
        self.plan["variables"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.plan["planned_values"]["outputs"]["lab_cycle_id"]["value"] = NEXT_CYCLE
        self.assertRejected("state remoto: lab_cycle_id no coincide")

    def test_deploy_rejects_cycle_change_hidden_from_outputs(self):
        # Defensa en profundidad: aunque el output no cambiara, reemplazar secretos se rechaza.
        self.deploy_update()
        self.state["resources"].append(resource("module.secrets", "aws_secretsmanager_secret", "token", ["internal"]))
        self.plan["resource_changes"].append(
            change('module.secrets.aws_secretsmanager_secret.token["internal"]', {}, {}, ["delete", "create"])
        )
        self.assertRejected("solo se admite en el apagado validado")

    def test_deploy_rejects_rds_replacement(self):
        self.deploy_update()
        self.plan["resource_changes"][0]["change"]["actions"] = ["create", "delete"]
        self.assertRejected("solo se admite en el apagado validado")

    def test_deploy_rejects_kms_key_deletion(self):
        self.deploy_update()
        self.state["resources"].append(resource("module.kms", "aws_kms_key", "data"))
        self.plan["resource_changes"].append(change("module.kms.aws_kms_key.data", {}, None, ["delete"]))
        self.assertRejected("solo se admite en el apagado validado")

    def test_deploy_accepts_non_stateful_replacement(self):
        self.deploy_update()
        self.state["resources"].append(
            resource("module.security_groups", "aws_vpc_security_group_ingress_rule", "alb_prefix_list", [0])
        )
        self.plan["resource_changes"].append(
            change(
                "module.security_groups.aws_vpc_security_group_ingress_rule.alb_prefix_list[0]",
                {},
                None,
                ["delete"],
            )
        )
        self.assertAccepted("actualización del mismo ciclo")

    def test_deploy_rejects_teardown_mode(self):
        self.deploy_update()
        self.plan["planned_values"]["outputs"]["teardown_mode"]["value"] = True
        self.assertRejected("teardown_mode debe ser false")

    def test_deploy_rejects_missing_teardown_output(self):
        self.deploy_update()
        del self.plan["planned_values"]["outputs"]["teardown_mode"]
        self.assertRejected("teardown_mode debe ser false")

    def test_deploy_rejects_partial_plan_missing_state_instance(self):
        self.deploy_update()
        del self.plan["resource_changes"][1]
        self.assertRejected("plan parcial, faltan instancias")

    def test_deploy_rejects_target_plan(self):
        self.deploy_update()
        self.tweak(lambda s: s["targets"].append('module.ecs.aws_ecs_service.this["identity"]'))
        self.assertRejected("plan parcial")

    def test_deploy_rejects_wrong_backend(self):
        self.deploy_update()
        self.metadata["backend"]["config"]["key"] = "spectra-shop/bootstrap/terraform.tfstate"
        self.assertRejected("backend inicializado")

    def test_deploy_rejects_wrong_workspace(self):
        self.deploy_update()
        (self.root / "environment").write_text("demo")
        self.assertRejected("workspace activo")

    def test_deploy_rejects_state_with_other_lineage(self):
        self.deploy_update()
        self.state["lineage"] = "22222222-2222-4222-8222-222222222222"
        self.assertRejected("lineage no coincide")

    def test_deploy_rejects_plan_not_matching_approved_state(self):
        self.deploy_update()
        self.tweak(lambda s: s["embedded"]["resources"].pop(2))
        self.assertRejected("state previo embebido no corresponde")

    def test_deploy_rejects_binary_different_from_validated_json(self):
        self.deploy_update()
        self.tweak(lambda s: s["variables"].update(lab_cycle_id=NEXT_CYCLE))
        self.assertRejected("no coinciden en la variable lab_cycle_id")

    def test_deploy_rejects_destroy_binary(self):
        self.deploy_update()
        self.tweak(lambda s: s.update(destroy=True))
        self.assertRejected("modo de plan")

    def test_deploy_rejects_invalid_resource_change(self):
        self.deploy_update()
        self.plan["resource_changes"].append({"address": "module.ecs.x", "mode": "managed", "module_address": "module.ecs"})
        self.assertRejected("resource_change inválido")

    # ---- Destrucción (F-03, F-04, F-08) -----------------------------------------------------------------

    def destroy_plan(self):
        self.mode = "destroy"
        self.plan = self.common(
            {
                "prior_state": {"values": {"outputs": {"lab_cycle_id": {"value": CYCLE}}}},
                "resource_changes": [
                    change(
                        "module.database.aws_db_instance.this",
                        {"deletion_protection": False, "skip_final_snapshot": True, "final_snapshot_identifier": None},
                        None,
                        ["delete"],
                    ),
                    change('module.ecs.aws_ecs_service.this["identity"]', {}, None, ["delete"]),
                    change("module.edge.aws_s3_bucket.spa", {"force_destroy": True}, None, ["delete"]),
                ],
                "output_changes": {"lab_cycle_id": {"actions": ["delete"], "before": CYCLE, "after": None}},
            }
        )
        self.write_all()
        return self.args()

    def destroy_args(self, mutate):
        self.destroy_plan()
        mutate(self.plan)
        self.write_all()
        return self.args()

    def assertDestroyRejected(self, mutate, fragment):
        args = self.destroy_args(mutate)
        with self.assertRaisesRegex(guard.GuardError, fragment):
            guard.verify(args)

    def test_accepts_destroy_of_only_lab_resources(self):
        self.assertEqual(guard.verify(self.destroy_plan()), "destrucción")

    def test_destroy_rejects_create_or_update(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][1]["change"].update(actions=["update"]),
            "solo se permiten eliminaciones",
        )

    def test_destroy_rejects_publisher_resource(self):
        self.destroy_plan()
        self.plan["resource_changes"].append(
            change('module.registry.aws_ecr_repository.this["identity-service"]', {}, None, ["delete"])
        )
        self.state["resources"].append(resource("module.registry", "aws_ecr_repository", "this", ["identity-service"]))
        self.assertRejected("recurso persistente prohibido")
        # Aunque el state no lo contenga, el plan tampoco puede incluirlo.
        self.state["resources"].pop()
        self.assertRejected("no corresponde al state")

    def test_destroy_rejects_final_snapshot_or_protected_rds(self):
        def mutate(plan):
            rds = plan["resource_changes"][0]["change"]["before"]
            rds["skip_final_snapshot"] = False
            rds["final_snapshot_identifier"] = "incompatible"

        self.assertDestroyRejected(mutate, "omitir el snapshot final")

    def test_destroy_rejects_other_cycle(self):
        self.assertDestroyRejected(
            lambda plan: plan["prior_state"]["values"]["outputs"]["lab_cycle_id"].update(value=NEXT_CYCLE),
            "prior_state no coincide",
        )

    def test_destroy_rejects_unknown_module_even_if_type_allowed(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][1].update(module_address="module.publisher"),
            "fuera del state lab",
        )

    def test_destroy_rejects_final_snapshot_without_name(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][0]["change"]["before"].update(skip_final_snapshot=False),
            "omitir el snapshot final",
        )

    def test_destroy_rejects_named_final_snapshot(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][0]["change"]["before"].update(final_snapshot_identifier="spectra-final"),
            "omitir el snapshot final",
        )

    def test_destroy_rejects_protected_rds(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][0]["change"]["before"].update(deletion_protection=True),
            "deletion_protection=true",
        )

    def test_destroy_rejects_spa_without_force_destroy(self):
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"][2]["change"]["before"].update(force_destroy=False),
            "force_destroy=true",
        )

    def test_destroy_rejects_protected_alb(self):
        self.state["resources"].append(resource("module.alb", "aws_lb", "this"))
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"].append(
                change("module.alb.aws_lb.this", {"enable_deletion_protection": True}, None, ["delete"])
            ),
            "enable_deletion_protection=false",
        )

    def test_destroy_rejects_partial_plan_without_rds(self):
        self.assertDestroyRejected(lambda plan: plan["resource_changes"].pop(0), "no corresponde al state")

    def test_destroy_rejects_plan_without_rds_even_if_state_matches(self):
        self.state["resources"] = self.state["resources"][1:]
        self.assertDestroyRejected(
            lambda plan: plan["resource_changes"].pop(0), "falta la eliminación comprobable del recurso RDS"
        )

    def test_destroy_rejects_targeted_partial_destroy(self):
        self.assertDestroyRejected(lambda plan: plan["resource_changes"].pop(1), "no corresponde al state")

    def test_destroy_rejects_binary_target_list(self):
        self.tweak(lambda s: s["targets"].append("module.ecs"))
        self.assertDestroyRejected(lambda plan: None, "plan parcial")

    def test_destroy_rejects_plan_that_deletes_nothing(self):
        def mutate(plan):
            for item in plan["resource_changes"]:
                item["change"]["actions"] = ["no-op"]

        self.assertDestroyRejected(mutate, "no elimina recursos")

    def test_destroy_rejects_unexpected_output_change(self):
        self.assertDestroyRejected(
            lambda plan: plan["output_changes"].update(
                lab_cycle_id={"actions": ["update"], "before": CYCLE, "after": NEXT_CYCLE}
            ),
            "cambio de output inesperado",
        )

    def test_destroy_rejects_normal_binary(self):
        self.tweak(lambda s: s.update(destroy=False))
        self.assertDestroyRejected(lambda plan: None, "modo de plan")

    def test_prepare_plan_is_rejected_in_destroy_mode(self):
        self.mode = "destroy"
        self.assertRejected("solo se permiten eliminaciones")


if __name__ == "__main__":
    unittest.main()
