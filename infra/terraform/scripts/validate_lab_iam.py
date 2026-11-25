#!/usr/bin/env python3
"""Valida localmente los artefactos IAM del laboratorio; no usa AWS ni modifica archivos."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
IAM = ROOT / "iam"
BOUNDARY_ARN = "arn:aws:iam::111122223333:policy/spectra-lab-runtime-boundary"
EXEC_ROLE = "arn:aws:iam::111122223333:role/spectra-lab-exec-*"
LAB_ROLES = {
    EXEC_ROLE,
    "arn:aws:iam::111122223333:role/spectra-lab-task-identity",
    "arn:aws:iam::111122223333:role/spectra-lab-vpc-flow-logs",
}
FILES = (
    "permissions-boundary.json",
    "plan-policy.json",
    "deploy-policy.json",
    "teardown-policy.json",
    "operator-policy.json",
    "permission-sets.json",
)
TOKENS = {
    "__ACCOUNT_ID__": "111122223333",
    "__REGION__": "us-east-1",
    "__TFSTATE_BUCKET__": "spectra-tfstate-111122223333-us-east-1",
    "__STATE_KMS_KEY_ARN__": "arn:aws:kms:us-east-1:111122223333:key/state",
    "__BOUNDARY_ARN__": BOUNDARY_ARN,
}


class ValidationError(ValueError):
    pass


def load(name: str, render: bool = False) -> dict[str, Any]:
    text = (IAM / name).read_text()
    if render:
        for token, value in TOKENS.items():
            text = text.replace(token, value)
        leftovers = sorted(set(re.findall(r"__[A-Z0-9_]+__", text)))
        if leftovers:
            raise ValidationError(f"{name}: tokens sin resolver: {leftovers}")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValidationError(f"{name}: raíz JSON no es objeto")
    return data


def statements(policy: dict[str, Any]) -> list[dict[str, Any]]:
    value = policy.get("Statement", [])
    return value if isinstance(value, list) else [value]


def actions(statement: dict[str, Any]) -> set[str]:
    value = statement.get("Action", [])
    return {value} if isinstance(value, str) else set(value)


def by_sid(policy: dict[str, Any], sid: str) -> dict[str, Any]:
    try:
        return next(item for item in statements(policy) if item.get("Sid") == sid)
    except StopIteration as exc:
        raise ValidationError(f"falta statement {sid}") from exc


def assert_no_admin(policy: dict[str, Any], name: str) -> None:
    for statement in statements(policy):
        if statement.get("Effect") != "Allow":
            continue
        allowed = actions(statement)
        if "*" in allowed or "iam:*" in allowed or "AdministratorAccess" in json.dumps(statement):
            raise ValidationError(f"{name}: permiso administrativo permitido")


def validate_boundary() -> None:
    policy = load("permissions-boundary.json", render=True)
    assert_no_admin(policy, "permissions-boundary.json")
    deny = by_sid(policy, "DenyPrivilegeEscalationAndBoundaryTampering")
    required = {"iam:*", "organizations:*", "account:*", "sts:AssumeRole"}
    if deny.get("Effect") != "Deny" or not required.issubset(actions(deny)):
        raise ValidationError("la boundary no deniega todas las rutas de escalada requeridas")
    token = by_sid(policy, "AllowEcrAuthorizationToken")
    if actions(token) != {"ecr:GetAuthorizationToken"} or token.get("Resource") != "*":
        raise ValidationError("solo ecr:GetAuthorizationToken puede usar Resource=*")
    for statement in statements(policy):
        if statement.get("Effect") == "Allow" and statement.get("Sid") != "AllowEcrAuthorizationToken" and statement.get("Resource") == "*":
            raise ValidationError(f"{statement.get('Sid')}: Allow no está acotado por recurso")
    if by_sid(policy, "AllowPullOnlySpectraRepositories").get("Resource") != "arn:aws:ecr:us-east-1:111122223333:repository/spectra/*":
        raise ValidationError("ECR de la boundary no está acotado a spectra/*")
    if by_sid(policy, "AllowOnlyLabLogGroups").get("Resource") != "arn:aws:logs:us-east-1:111122223333:log-group:/spectra/lab/*:*":
        raise ValidationError("Logs de la boundary no están acotados a /spectra/lab/*")
    if by_sid(policy, "AllowOnlyLabSecrets").get("Resource") != "arn:aws:secretsmanager:us-east-1:111122223333:secret:spectra/lab/*":
        raise ValidationError("Secrets Manager no está acotado al prefijo del lab")
    keys = by_sid(policy, "AllowOnlyTaggedLabKeys")
    if keys.get("Resource") != "arn:aws:kms:us-east-1:111122223333:key/*" or keys.get("Condition") != {"StringEquals": {"aws:ResourceTag/Project": "spectra-shop", "aws:ResourceTag/Environment": "lab"}}:
        raise ValidationError("KMS no está acotado por cuenta, región y tags del lab")


def validate_deployer() -> None:
    deploy = load("deploy-policy.json", render=True)
    assert_no_admin(deploy, "deploy-policy.json")
    mutation = by_sid(deploy, "DenyBoundaryPolicyMutation")
    required = {"iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"}
    if mutation.get("Effect") != "Deny" or mutation.get("Resource") != BOUNDARY_ARN or not required.issubset(actions(mutation)):
        raise ValidationError("deployer puede modificar, eliminar o sustituir la boundary")
    if by_sid(deploy, "DenyRemovingAnyRoleBoundary").get("Effect") != "Deny":
        raise ValidationError("deployer puede retirar la boundary")
    create = by_sid(deploy, "CreateOnlyBoundedLabRoles")
    if create.get("Condition") != {"ArnEquals": {"iam:PermissionsBoundary": BOUNDARY_ARN}}:
        raise ValidationError("CreateRole no exige la boundary exacta")
    replace = by_sid(deploy, "DenyReplacingWithAnotherBoundary")
    if replace.get("Effect") != "Deny" or replace.get("Condition") is not None:
        raise ValidationError("PutRolePermissionsBoundary no está denegado de forma incondicional")
    passed = by_sid(deploy, "PassOnlyBoundedLabRolesToRequiredServices")
    for sid in ("CreateOnlyBoundedLabRoles", "ManageOnlyBoundedLabRoles",
                "PassOnlyBoundedLabRolesToRequiredServices"):
        resources = by_sid(deploy, sid).get("Resource")
        if not isinstance(resources, list) or set(resources) != LAB_ROLES:
            raise ValidationError(f"{sid}: alcance de roles incorrecto")
    services = passed.get("Condition", {}).get("StringEquals", {}).get("iam:PassedToService", [])
    if set(services) != {"ecs-tasks.amazonaws.com", "vpc-flow-logs.amazonaws.com"}:
        raise ValidationError("PassRole no exige los servicios exactos")
    region = by_sid(deploy, "DenyRegionalActionsOutsideUsEast1")
    if region.get("Effect") != "Deny" or region.get("Condition") != {"StringNotEquals": {"aws:RequestedRegion": "us-east-1"}}:
        raise ValidationError("deployer no falla cerrado fuera de us-east-1")
    required_tag_denies = {
        "cloudfront:*Distribution", "cloudfront:*VpcOrigin",
        "ec2:DeleteFlowLogs", "ec2:DeleteVpc*", "ec2:Modify*Attribute",
        "ecs:*Cluster", "ecs:*Service",
        "logs:DeleteLogGroup", "logs:DeleteMetricFilter",
        "rds:*DBInstance", "rds:*DBParameterGroup", "rds:*DBSubnetGroup",
        "sns:DeleteTopic", "wafv2:*IPSet", "wafv2:DeleteWebACL", "wafv2:UpdateWebACL",
    }
    unsupported_tag_wildcards = {
        "cloudfront:Update*", "cloudfront:Delete*", "ec2:Modify*", "ec2:Delete*",
        "ecs:Delete*", "logs:Delete*", "rds:Modify*", "rds:Delete*",
        "sns:Delete*", "wafv2:Update*", "wafv2:Delete*",
    }
    for sid, key, value in (
        ("DenyForeignProject", "aws:ResourceTag/Project", "spectra-shop"),
        ("DenyForeignEnvironment", "aws:ResourceTag/Environment", "lab"),
    ):
        deny = by_sid(deploy, sid)
        if deny.get("Effect") != "Deny" or not required_tag_denies.issubset(actions(deny)):
            raise ValidationError(f"{sid}: faltan mutaciones protegidas por tags")
        if actions(deny) & unsupported_tag_wildcards:
            raise ValidationError(f"{sid}: comodines incompatibles con ResourceTag")
        if deny.get("Condition") != {
            "StringNotEquals": {key: value}, "Null": {key: "false"}
        }:
            raise ValidationError(f"{sid}: condición de tag incorrecta")
    create = by_sid(deploy, "CreateLabResourcesOnlyWithRequiredTags")
    expected_tags = {
        "StringEquals": {"aws:RequestTag/Project": "spectra-shop", "aws:RequestTag/Environment": "lab"},
        "Null": {"aws:RequestTag/LabCycle": "false"},
    }
    if create.get("Condition") != expected_tags:
        raise ValidationError("creación de recursos no exige Project/Environment/LabCycle")
    kms = by_sid(deploy, "ManageOnlyTaggedLabKmsKeys")
    if "kms:PutKeyPolicy" not in actions(kms) or kms.get("Resource") != "arn:aws:kms:us-east-1:111122223333:key/*" or "Condition" not in kms:
        raise ValidationError("kms:PutKeyPolicy no está aislado a claves lab etiquetadas")
    grant = by_sid(deploy, "CreateGrantsOnlyForAwsResourcesOnTaggedLabKeys")
    if grant.get("Condition", {}).get("Bool", {}).get("kms:GrantIsForAWSResource") != "true":
        raise ValidationError("kms:CreateGrant no exige GrantIsForAWSResource")
    broad = by_sid(deploy, "ManageExistingLabResources")
    dangerous = {"kms:PutKeyPolicy", "kms:CreateGrant", "s3:PutBucketPolicy",
                 "s3:PutBucketOwnershipControls", "s3:CreateBucket"}
    if actions(broad) & dangerous:
        raise ValidationError("acciones sensibles permanecen en el bloque general")
    create = actions(by_sid(deploy, "CreateLabResourcesOnlyWithRequiredTags"))
    required_create = {
        "elasticloadbalancing:CreateRule",
        "rds:CreateDBParameterGroup",
    }
    if not required_create.issubset(create):
        raise ValidationError("inventario deploy no cubre todos los recursos creados por lab")
    required_manage = {
        "cloudfront:CreateResponseHeadersPolicy",
        "cloudfront:DeleteResponseHeadersPolicy",
        "elasticloadbalancing:DeleteRule",
        "rds:DeleteDBParameterGroup",
        "wafv2:PutLoggingConfiguration",
    }
    if not required_manage.issubset(actions(broad)):
        raise ValidationError("inventario deploy no cubre operaciones auxiliares de Terraform")
    budget = by_sid(deploy, "ManageOnlyFixedLabBudget")
    if (budget.get("Resource") != "arn:aws:budgets::111122223333:budget/spectra-lab-monthly"
            or actions(budget) != {"budgets:ModifyBudget"}):
        raise ValidationError("presupuesto deploy no está acotado al nombre fijo del lab")
    spa = by_sid(deploy, "ManageOnlyFixedLabSpaBucket")
    if "s3:PutBucketOwnershipControls" not in actions(spa) or set(spa.get("Resource", [])) != {
        "arn:aws:s3:::spectra-lab-spa-111122223333",
        "arn:aws:s3:::spectra-lab-spa-111122223333/*",
    }:
        raise ValidationError("controles de propiedad S3 fuera del bucket SPA del lab")


def validate_state_permissions() -> None:
    state = "arn:aws:s3:::spectra-tfstate-111122223333-us-east-1/spectra-shop/lab/terraform.tfstate"
    lock = f"{state}.tflock"
    plan = load("plan-policy.json", render=True)
    read = by_sid(plan, "ReadLabState")
    if actions(read) != {"s3:GetObject"} or read.get("Resource") != state:
        raise ValidationError("plan puede escribir o borrar el state")
    lock_statement = by_sid(plan, "ManageOnlyLabStateLock")
    if actions(lock_statement) != {"s3:GetObject", "s3:PutObject", "s3:DeleteObject"} or lock_statement.get("Resource") != lock:
        raise ValidationError("plan no limita escritura/borrado al lock")
    deploy_write = by_sid(load("deploy-policy.json", render=True), "WriteLabState")
    if (actions(deploy_write) != {"s3:PutObject", "s3:DeleteObject"}
            or deploy_write.get("Resource") != state):
        raise ValidationError("deploy: escritura de state fuera de la clave lab")
    teardown_write = by_sid(load("teardown-policy.json", render=True), "WriteOnlyLabStateAndLock")
    if set(teardown_write.get("Resource", [])) != {state, lock}:
        raise ValidationError("teardown-policy.json: escritura de state fuera de la clave lab")


def validate_teardown_and_operator() -> None:
    teardown = load("teardown-policy.json", render=True)
    operator = load("operator-policy.json", render=True)
    assert_no_admin(teardown, "teardown-policy.json")
    assert_no_admin(operator, "operator-policy.json")
    teardown_allows = set().union(*(actions(s) for s in statements(teardown) if s.get("Effect") == "Allow"))
    forbidden_combo = {"iam:CreateRole", "iam:PutRolePolicy", "iam:PassRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"}
    if teardown_allows & forbidden_combo:
        raise ValidationError("teardown combina retirada de boundary con una ruta de escalada")
    required_teardown = {
        "budgets:ModifyBudget",
        "cloudfront:DeleteResponseHeadersPolicy",
        "elasticloadbalancing:DeleteRule",
        "rds:DeleteDBParameterGroup",
        "s3:PutBucketOwnershipControls",
        "wafv2:DeleteLoggingConfiguration",
    }
    if not required_teardown.issubset(teardown_allows):
        raise ValidationError("inventario teardown no cubre todos los recursos del lab")
    teardown_deny = by_sid(teardown, "DenyBoundaryPolicyMutationDuringTeardown")
    required = {"iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"}
    if teardown_deny.get("Effect") != "Deny" or not required.issubset(actions(teardown_deny)):
        raise ValidationError("teardown puede mutar o retirar la boundary")
    resources = by_sid(teardown, "DeleteOnlyLabRolesAfterDependentResources").get("Resource")
    if not isinstance(resources, list) or set(resources) != LAB_ROLES:
        raise ValidationError("teardown puede borrar roles fuera del lab")
    operator_deny = by_sid(operator, "NoIamOrInfrastructureMutation")
    if operator_deny.get("Effect") != "Deny" or not {"iam:Create*", "iam:Put*", "iam:Update*"}.issubset(actions(operator_deny)):
        raise ValidationError("operator no bloquea mutaciones IAM")
    operator_pass = by_sid(operator, "PassOnlyLabExecutionRolesToEcs")
    if operator_pass.get("Resource") != EXEC_ROLE or operator_pass.get("Condition") != {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}:
        raise ValidationError("operator PassRole no está acotado a ECS y roles lab")


def validate_terraform_wiring() -> None:
    expected = {
        ROOT / "modules/ecs/iam.tf": 2,
        ROOT / "modules/network/main.tf": 1,
    }
    total = 0
    for path, resource_count in expected.items():
        text = path.read_text()
        roles = len(re.findall(r'resource\s+"aws_iam_role"\s+"', text))
        boundaries = len(re.findall(r'permissions_boundary\s*=\s*var\.permissions_boundary_arn', text))
        if roles != resource_count or boundaries != roles:
            raise ValidationError(f"{path}: {roles} declaraciones de rol y {boundaries} boundary; deben coincidir")
        total += 10 if path.name == "iam.tf" else 1
    # ecs/iam.tf declara una colección de 10 execution roles y un identity task role.
    total = 12
    if total != 12:
        raise ValidationError("inventario esperado de roles cambió")
    root = (ROOT / "environments/lab/main.tf").read_text()
    if len(re.findall(r"permissions_boundary_arn\s*=\s*var\.lab_role_permissions_boundary_arn", root)) != 2:
        raise ValidationError("la raíz lab no cablea la boundary a ECS y network")


def validate_permission_sets() -> None:
    manifest = load("permission-sets.json", render=True)
    sets = {item["name"]: item for item in manifest.get("permission_sets", [])}
    if set(sets) != {"spectra-lab-deployer", "spectra-lab-operator"}:
        raise ValidationError("permission sets inesperados")
    deployer = sets["spectra-lab-deployer"]
    if deployer.get("base_policy") != "plan-policy.json" or deployer.get("phase_policy_variants") != ["deploy-policy.json", "teardown-policy.json"]:
        raise ValidationError("faltan variantes plan/deploy/teardown")
    for name in FILES:
        load(name, render=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    try:
        validate_boundary()
        validate_deployer()
        validate_state_permissions()
        validate_teardown_and_operator()
        validate_terraform_wiring()
        validate_permission_sets()
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        print(f"FAIL IAM lab: {exc}", file=sys.stderr)
        return 1
    if not args.quiet:
        print("OK IAM lab: 12 roles con boundary; políticas plan/deploy/teardown/operator sin rutas de escalada detectadas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
