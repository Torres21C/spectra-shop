# Versiones verificadas el 2026-11-21 (`terraform providers schema -json`):
#   - Terraform >= 1.11: recursos efímeros y atributos write-only (secretos fuera del state).
#   - hashicorp/aws 6.70.x: secret_string_wo / secret_string_wo_version, aws_cloudfront_vpc_origin.
#   - hashicorp/random 3.9.x: ephemeral "random_password".
# .terraform.lock.hcl fija los hashes exactos; se versiona.
terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70.0"
    }
    # Lo usa el módulo secrets (ephemeral random_password); se declara aquí para fijar su versión en el
    # .terraform.lock.hcl del entorno.
    # tflint-ignore: terraform_unused_required_providers
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9.0"
    }
  }
}
