variable "aws_region" {
  description = "Región AWS. AD-01: us-east-1 (la misma que lab; las task definitions leen las imágenes de este registro)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "Los repositorios se crean en us-east-1, la región del laboratorio (AD-01)."
  }
}

variable "environment" {
  description = "Nombre del entorno. Forma parte del nombre del rol (spectra-<entorno>-ecr-publisher), que el workflow ecr-publish exige como spectra-lab-ecr-publisher."
  type        = string
  default     = "lab"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.environment))
    error_message = "environment: minúsculas y dígitos, de 2 a 10 caracteres."
  }
}

# ---------------------------------------------------------------------------------------------------------
# Repositorios ECR (antes en environments/lab)
# ---------------------------------------------------------------------------------------------------------

variable "ecr_force_delete" {
  description = "Permite destruir repositorios ECR con imágenes."
  type        = bool
  default     = false
}

variable "ecr_keep_images" {
  description = "Imágenes etiquetadas conservadas por repositorio."
  type        = number
  default     = 20
}

# ---------------------------------------------------------------------------------------------------------
# Rol publicador para GitHub Actions (OIDC). Ver ADR-AWS-06.
# ---------------------------------------------------------------------------------------------------------

variable "enable_ecr_publisher" {
  description = "Crea el rol OIDC publicador de ECR. false hasta que el propietario autorice la publicación (con false solo se crean los repositorios)."
  type        = bool
  default     = false
}

variable "create_github_oidc_provider" {
  description = "true: crea el proveedor OIDC de GitHub. false: usa el que ya existe en la cuenta (se lee por URL y se valida la audiencia; no se importa). Comprobar antes con una consulta de solo lectura."
  type        = bool
  default     = true
}

variable "github_oidc_subject_prefix" {
  description = "Prefijo inmutable del claim sub de este repositorio (GET /repos/Torres21C/spectra-shop/actions/oidc/customization/sub)."
  type        = string
  default     = "repo:Torres21C@84191196/spectra-shop@1457499804"
}

variable "github_publish_environment" {
  description = "GitHub Environment con aprobación humana y restringido a main desde el que se publica."
  type        = string
  default     = "ecr-publish-lab"
}
