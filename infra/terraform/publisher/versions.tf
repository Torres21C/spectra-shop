# Misma versión de Terraform y del proveedor que environments/lab (versions.tf de lab). Solo usa el
# proveedor aws; .terraform.lock.hcl fija los mismos hashes que lab y se versiona.
terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70.0"
    }
  }
}
