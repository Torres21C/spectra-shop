#!/usr/bin/env python3
"""Render local IAM templates and evaluate a focused matrix in AWS IAM Policy Simulator."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

IAM = Path(__file__).resolve().parents[1] / "iam"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", default="spectra-readonly")
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(mode=0o700)
    state = json.loads(args.bootstrap_state.read_text())
    outputs = {key: item["value"] for key, item in state["outputs"].items()}
    key = outputs["state_kms_key_arn"]
    _, _, _, region, account, _ = key.split(":", 5)
    if region != "us-east-1" or not re.fullmatch(r"\d{12}", account):
        raise SystemExit("state de bootstrap fuera del alcance")
    bucket = outputs["state_bucket"]
    iam = f"arn:aws:iam::{account}"
    boundary = f"{iam}:policy/spectra-lab-runtime-boundary"
    tokens = dict(ACCOUNT_ID=account, REGION=region, TFSTATE_BUCKET=bucket,
                  STATE_KMS_KEY_ARN=key, BOUNDARY_ARN=boundary)
    documents = {}
    for name in ("plan-policy", "deploy-policy", "teardown-policy", "operator-policy", "permissions-boundary"):
        source = (IAM / f"{name}.json").read_text()
        for token, value in tokens.items():
            source = source.replace(f"__{token}__", value)
        if re.search(r"__[A-Z0-9_]+__", source):
            raise SystemExit(f"tokens sin resolver en {name}")
        rendered = json.dumps(json.loads(source), separators=(",", ":"))
        limit = 6144 if name in ("plan-policy", "permissions-boundary") else 10240
        if len(rendered.encode()) > limit:
            raise SystemExit(f"{name} supera su cuota de bytes")
        documents[name] = rendered
        (args.output / f"{name}.json").write_text(rendered + "\n")

    plan, deploy, teardown, operator, runtime = documents.values()
    role = f"{iam}:role/spectra-lab-exec-identity"
    publisher = f"{iam}:role/spectra-lab-ecr-publisher"
    state_object = f"arn:aws:s3:::{bucket}/spectra-shop/lab/terraform.tfstate"
    ecs_service = f"arn:aws:ecs:{region}:{account}:service/spectra-lab/spectra-lab-identity"

    def context(name, value):
        return {"ContextKeyName": name, "ContextKeyValues": [value], "ContextKeyType": "string"}

    allowed, explicit, implicit = "allowed", "explicitDeny", "implicitDeny"
    cases = [
        ("plan-read", [plan], state_object, [], {"s3:GetObject": allowed, "s3:PutObject": implicit, "s3:DeleteObject": implicit}),
        ("plan-lock", [plan], state_object + ".tflock", [], {"s3:PutObject": allowed, "s3:DeleteObject": allowed}),
        ("deploy-no-boundary", [plan, deploy], role, [], {"iam:CreateRole": explicit, "iam:PutRolePermissionsBoundary": explicit, "iam:DeleteRolePermissionsBoundary": explicit}),
        ("deploy-exact-boundary", [plan, deploy], role, [context("iam:PermissionsBoundary", boundary)], {"iam:CreateRole": allowed}),
        ("deploy-other-boundary", [plan, deploy], role, [context("iam:PermissionsBoundary", f"{iam}:policy/other")], {"iam:CreateRole": implicit}),
        ("deploy-protect-policy", [plan, deploy], boundary, [], dict.fromkeys(["iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicyVersion", "iam:DeletePolicy"], explicit)),
        ("deploy-publisher", [plan, deploy], publisher, [context("iam:PassedToService", "ecs-tasks.amazonaws.com")], dict.fromkeys(["iam:PassRole", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole", "iam:AttachRolePolicy"], implicit)),
        ("deploy-pass-runtime", [plan, deploy], role, [context("iam:PassedToService", "ecs-tasks.amazonaws.com")], {"iam:PassRole": allowed, "iam:AttachRolePolicy": implicit}),
        ("deploy-pass-other-service", [plan, deploy], role, [context("iam:PassedToService", "lambda.amazonaws.com")], {"iam:PassRole": implicit}),
        ("deploy-tagged-service", [plan, deploy], ecs_service,
         [context("aws:RequestedRegion", region), context("aws:ResourceTag/Project", "spectra-shop"), context("aws:ResourceTag/Environment", "lab")],
         {"ecs:UpdateService": allowed}),
        ("deploy-foreign-project", [plan, deploy], ecs_service,
         [context("aws:RequestedRegion", region), context("aws:ResourceTag/Project", "other"), context("aws:ResourceTag/Environment", "lab")],
         {"ecs:UpdateService": explicit}),
        ("deploy-foreign-environment", [plan, deploy], ecs_service,
         [context("aws:RequestedRegion", region), context("aws:ResourceTag/Project", "spectra-shop"), context("aws:ResourceTag/Environment", "prod")],
         {"ecs:UpdateService": explicit}),
        ("teardown-role", [plan, teardown], role, [], {"iam:DeleteRole": allowed, "iam:DeleteRolePermissionsBoundary": explicit, "iam:PutRolePolicy": implicit, "iam:PassRole": implicit}),
        ("teardown-bootstrap-budget", [plan, teardown], f"arn:aws:budgets::{account}:budget/spectra-account-monthly", [], {"budgets:ModifyBudget": implicit}),
        ("teardown-state-bucket", [plan, teardown], f"arn:aws:s3:::{bucket}", [], {"s3:DeleteBucket": implicit, "s3:PutBucketOwnershipControls": implicit}),
        ("operator-ecs", [operator], role, [context("iam:PassedToService", "ecs-tasks.amazonaws.com")], {"iam:PassRole": allowed, "iam:PutRolePolicy": explicit}),
        ("operator-publisher", [operator], publisher, [context("iam:PassedToService", "ecs-tasks.amazonaws.com")], {"iam:PassRole": implicit}),
        ("runtime-iam", [runtime], role, [], {"iam:PutRolePolicy": explicit, "sts:AssumeRole": explicit}),
    ]
    summary = []
    for name, policies, resource, contexts, expected in cases:
        request = {"PolicyInputList": policies, "ResourceArns": [resource],
                   "ActionNames": list(expected), "ContextEntries": contexts}
        result = subprocess.run(
            ["aws", "iam", "simulate-custom-policy", "--profile", args.profile,
             "--output", "json", "--cli-input-json", json.dumps(request)],
            capture_output=True, text=True,
        )
        if result.returncode:
            (args.output / f"{name}.error.log").write_text(result.stderr)
            raise SystemExit(f"{name}: falló IAM Policy Simulator (rc={result.returncode})")
        (args.output / f"{name}.result.json").write_text(result.stdout)
        actual = {item["EvalActionName"]: item["EvalDecision"]
                  for item in json.loads(result.stdout)["EvaluationResults"]}
        summary.extend({"case": name, "action": action,
                        "expected": decision, "actual": actual.get(action)}
                       for action, decision in expected.items())
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    passed = sum(item["expected"] == item["actual"] for item in summary)
    for item in summary:
        if item["expected"] != item["actual"]:
            print(item)
    print(f"IAM Policy Simulator: {passed}/{len(summary)}")
    return int(passed != len(summary))


if __name__ == "__main__":
    raise SystemExit(main())
