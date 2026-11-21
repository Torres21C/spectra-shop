provider "aws" {
  region = var.aws_region

  # Etiquetas en todos los recursos (plan §16.2: verificación de la destrucción por etiquetas).
  default_tags {
    tags = {
      Project     = "spectra-shop"
      Environment = var.environment
      ManagedBy   = "terraform"
      Stack       = "infra/terraform/environments/${var.environment}"
    }
  }
}
