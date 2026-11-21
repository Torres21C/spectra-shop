# TFLint con el ruleset de Terraform integrado (sin plugins descargados). El ruleset de AWS
# (terraform-linters/tflint-ruleset-aws) queda pendiente de autorización (README, «Validación»).
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}
