terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "spectra-shop"
      Environment = "shared"
      ManagedBy   = "terraform"
      Stack       = "infra/terraform/bootstrap"
    }
  }
}
