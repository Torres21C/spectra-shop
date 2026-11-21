"""Control F: la excepción OIDC de PR-6 no permite credenciales, permisos, disparadores, operaciones ni workflows
adicionales. Cada mutación de los workflows o scripts reales debe hacer fallar scripts/ci/verify_workflows.py."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.tests.helpers import ROOT

PUBLISH = ".github/workflows/ecr-publish.yml"
CI = ".github/workflows/ci.yml"
IAC = ".github/workflows/iac.yml"


def replace(text: str, old: str, new: str, count: int = 1) -> str:
    if old not in text:
        raise AssertionError(f"mutación no aplicable: {old[:60]!r}")
    return text.replace(old, new, count)


MUTATIONS = {
    "oidc_en_ci": (CI, lambda t: replace(t, "  contents: read\n", "  contents: read\n  id-token: write\n")),
    "oidc_en_iac": (IAC, lambda t: replace(t, "      contents: read\n", "      contents: read\n      id-token: write\n")),
    "oidc_en_build_scan": (PUBLISH, lambda t: replace(t, "    permissions:\n      contents: read\n    outputs:\n      digests_sha256",
                                                      "    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      digests_sha256")),
    "credenciales_en_verify": (PUBLISH, lambda t: replace(t, "      - name: Verificar el commit, los checks y el Environment\n",
        "      - name: Credenciales\n        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0\n        with:\n          role-to-assume: ${{ vars.AWS_ECR_PUBLISHER_ROLE_ARN }}\n          aws-region: us-east-1\n\n      - name: Verificar el commit, los checks y el Environment\n")),
    "disparador_push": (PUBLISH, lambda t: replace(t, "on:\n  workflow_dispatch:\n", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n")),
    "disparador_pull_request": (PUBLISH, lambda t: replace(t, "on:\n  workflow_dispatch:\n", "on:\n  pull_request:\n  workflow_dispatch:\n")),
    "pull_request_target_en_ci": (CI, lambda t: replace(t, "on:\n", "on:\n  pull_request_target:\n    branches: [main]\n")),
    "workflow_run": (IAC, lambda t: replace(t, "on:\n", "on:\n  workflow_run:\n    workflows: [ci]\n    types: [completed]\n")),
    "claves_estaticas": (PUBLISH, lambda t: replace(t, "      AWS_REGION: ${{ vars.AWS_REGION }}\n",
                                                    "      AWS_REGION: ${{ vars.AWS_REGION }}\n      AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}\n")),
    "rol_desde_secreto": (PUBLISH, lambda t: replace(t, "role-to-assume: ${{ vars.AWS_ECR_PUBLISHER_ROLE_ARN }}",
                                                     "role-to-assume: ${{ secrets.PUBLISHER_ROLE }}")),
    "sin_environment": (PUBLISH, lambda t: replace(t, "    environment: ecr-publish-lab\n", "")),
    "environment_dinamico": (PUBLISH, lambda t: replace(t, "    environment: ecr-publish-lab\n", "    environment: ${{ inputs.env }}\n")),
    "otro_environment": (PUBLISH, lambda t: replace(t, "    environment: ecr-publish-lab\n", "    environment: production\n")),
    "publish_sin_main": (PUBLISH, lambda t: replace(t, "if: github.ref == 'refs/heads/main' && inputs.publish", "if: inputs.publish")),
    "verify_sin_main": (PUBLISH, lambda t: replace(t, "    if: github.ref == 'refs/heads/main'\n    runs-on", "    runs-on")),
    "permiso_de_escritura": (PUBLISH, lambda t: replace(t, "      contents: read\n      id-token: write\n", "      contents: write\n      id-token: write\n")),
    "permiso_packages": (PUBLISH, lambda t: replace(t, "      contents: read\n      id-token: write\n", "      contents: read\n      id-token: write\n      packages: write\n")),
    "oidc_a_nivel_de_workflow": (PUBLISH, lambda t: replace(t, "permissions: {}\n", "permissions:\n  id-token: write\n")),
    "accion_sin_sha": (PUBLISH, lambda t: replace(t, "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5", "actions/checkout@v5")),
    "despliegue_ecs": (PUBLISH, lambda t: replace(t, "      - name: Guardar el manifiesto de publicación\n",
        "      - name: Desplegar\n        shell: bash\n        run: aws ecs update-service --cluster spectra-lab --service identity\n\n      - name: Guardar el manifiesto de publicación\n")),
    "terraform_apply": (PUBLISH, lambda t: replace(t, "run: scripts/ecr/publish-images.sh \"$RUNNER_TEMP/release\"",
                                                   "run: terraform -chdir=infra/terraform/environments/lab apply -auto-approve")),
    "migraciones": (PUBLISH, lambda t: replace(t, "run: scripts/ecr/publish-images.sh \"$RUNNER_TEMP/release\"",
                                               "run: npx prisma migrate deploy")),
    "inyeccion_en_run": (PUBLISH, lambda t: replace(t, "run: scripts/ecr/build-images.sh \"$RUNNER_TEMP/release\"",
                                                    "run: echo ${{ inputs.commit_sha }} && scripts/ecr/build-images.sh \"$RUNNER_TEMP/release\"")),
    "checkout_con_credenciales": (PUBLISH, lambda t: replace(t, "persist-credentials: false", "persist-credentials: true")),
    "job_adicional": (PUBLISH, lambda t: t + "\n  deploy:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n    steps:\n      - run: echo hola\n"),
    "publish_sin_build_scan": (PUBLISH, lambda t: replace(t, "needs: [verify, build-scan]", "needs: [verify]")),
    "secretos_en_build_scan": (PUBLISH, lambda t: replace(t, "      COMMIT_SHA: ${{ needs.verify.outputs.sha }}\n    steps:",
                                                          "      COMMIT_SHA: ${{ needs.verify.outputs.sha }}\n      TOKEN: ${{ secrets.NPM_TOKEN }}\n    steps:")),
    "script_borra_imagenes": ("scripts/ecr/publish-images.sh", lambda t: replace(t, "# 5) Manifiesto de publicación.",
        "aws ecr batch-delete-image --repository-name x --image-ids imageTag=y\n# 5) Manifiesto de publicación.")),
    "script_iam": ("scripts/ecr/publish-images.sh", lambda t: replace(t, "# 5) Manifiesto de publicación.",
                                                                      "aws iam attach-role-policy --role-name x --policy-arn y\n# 5) Manifiesto de publicación.")),
    "workflow_nuevo_con_oidc": (".github/workflows/deploy.yml", lambda t: (
        "name: deploy\non:\n  workflow_dispatch:\npermissions:\n  id-token: write\n  contents: read\njobs:\n"
        "  deploy:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hola\n")),
}


class VerifyWorkflowsTests(unittest.TestCase):
    def make_tree(self) -> Path:
        tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / ".github/workflows", tmp / ".github/workflows")
        shutil.copytree(ROOT / "scripts/ecr", tmp / "scripts/ecr")
        return tmp

    def verify(self, root: Path) -> subprocess.CompletedProcess:
        return subprocess.run(["python3", "-I", str(ROOT / "scripts/ci/verify_workflows.py"), str(root)],
                              capture_output=True, text=True)

    def test_real_workflows_pass(self):
        result = self.verify(self.make_tree())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mutations_are_rejected(self):
        for name, (relative, mutate) in MUTATIONS.items():
            with self.subTest(mutation=name):
                root = self.make_tree()
                target = root / relative
                target.write_text(mutate(target.read_text() if target.exists() else ""))
                result = self.verify(root)
                self.assertEqual(result.returncode, 1, f"{name} no fue detectada:\n{result.stdout}")
                self.assertIn("FAIL", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
