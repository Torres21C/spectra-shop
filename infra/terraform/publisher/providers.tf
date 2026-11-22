provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "spectra-shop"
      Environment = var.environment
      ManagedBy   = "terraform"
      Stack       = "infra/terraform/publisher"
    }
  }
}
