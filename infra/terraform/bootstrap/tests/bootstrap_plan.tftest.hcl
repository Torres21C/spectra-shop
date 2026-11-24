# Bootstrap del state (PR-5) y su auditoría (PR-6.2, R-PR5-26) con proveedor AWS SIMULADO: `terraform test`
# no usa credenciales ni contacta con AWS. Solo `command = plan`. Comprueba que el bucket del state conserva
# sus controles y que el trail registra SOLO los objetos del bucket del state, cifrado con la CMK del state,
# con validación de integridad, retención de 365 días y sin poder borrar versiones de los registros.
# `prevent_destroy` no se puede evaluar en un plan: lo comprueba scripts/check_state_ownership.py.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_kms_key" {
    override_during = plan
    defaults = {
      arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    }
  }
}

variables {
  budget_emails = ["owner@example.invalid"]
}

run "state_bucket_keeps_its_controls" {
  command = plan

  override_resource {
    target          = aws_s3_bucket.state
    override_during = plan
    values = {
      arn = "arn:aws:s3:::spectra-tfstate-111122223333-us-east-1"
      id  = "spectra-tfstate-111122223333-us-east-1"
    }
  }

  assert {
    condition     = aws_s3_bucket.state.bucket == "spectra-tfstate-111122223333-us-east-1"
    error_message = "Nombre del bucket del state: spectra-tfstate-<cuenta>-<región>."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "El bucket del state bloquea todo acceso público."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.state.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACL desactivadas en el bucket del state."
  }

  assert {
    condition     = one(aws_s3_bucket_versioning.state.versioning_configuration).status == "Enabled"
    error_message = "El bucket del state está versionado."
  }

  assert {
    condition = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : (
      one(r.apply_server_side_encryption_by_default).sse_algorithm == "aws:kms"
    && one(r.apply_server_side_encryption_by_default).kms_master_key_id == aws_kms_key.state.arn)])
    error_message = "El state se cifra con SSE-KMS y la CMK del state."
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation && aws_kms_key.state.deletion_window_in_days == 30
    error_message = "CMK del state con rotación y ventana de borrado de 30 días."
  }

  assert {
    condition = toset([for s in data.aws_iam_policy_document.state_bucket.statement : s.sid if s.effect == "Deny"]) == toset([
      "DenyInsecureTransport", "DenyUnencryptedObjectUploads",
    ])
    error_message = "La política del bucket del state deniega el acceso sin TLS y las subidas sin SSE-KMS."
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : r.bucket_key_enabled])
    error_message = "El bucket del state conserva S3 Bucket Key (CloudTrail no escribe en él)."
  }
}

run "state_bucket_denies_other_principals_including_versions" {
  command = plan

  variables {
    state_admin_role_arns = [
      "arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_spectra-publisher-deployer_*",
      "arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_spectra-lab-deployer_*",
    ]
  }

  override_resource {
    target          = aws_s3_bucket.state
    override_during = plan
    values = {
      arn = "arn:aws:s3:::spectra-tfstate-111122223333-us-east-1"
      id  = "spectra-tfstate-111122223333-us-east-1"
    }
  }

  assert {
    # Lista exacta: ni se pierde una acción ni se deniegan otras (ListBucket y la configuración del bucket).
    condition = one([for s in data.aws_iam_policy_document.state_bucket.statement : toset(s.actions) if s.sid == "DenyOtherPrincipals"]) == toset([
      "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
    ])
    error_message = "Otros principales no leen, escriben ni borran objetos del state ni sus versiones."
  }

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.state_bucket.statement : (
      s.effect == "Deny"
      && toset(s.resources) == toset(["arn:aws:s3:::spectra-tfstate-111122223333-us-east-1/*"])
      && anytrue([for p in s.principals : p.type == "*" && toset(p.identifiers) == toset(["*"])])
    ) if s.sid == "DenyOtherPrincipals"])
    error_message = "La denegación se aplica a todos los principales y solo a los objetos del bucket del state."
  }

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.state_bucket.statement : (
      length(s.condition) == 1 && one(s.condition).test == "ArnNotLike" && one(s.condition).variable == "aws:PrincipalArn"
      && toset(one(s.condition).values) == toset(var.state_admin_role_arns)
    ) if s.sid == "DenyOtherPrincipals"])
    error_message = "Solo los roles de state_admin_role_arns quedan exceptuados (backend de publisher y lab)."
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.state_bucket.statement : s if s.effect != "Deny"]) == 0
    error_message = "La política del bucket del state no concede acceso a nadie: solo deniega."
  }
}

run "audit_trail_scope_is_only_the_state_bucket" {
  command = plan

  override_resource {
    target          = aws_s3_bucket.state
    override_during = plan
    values = {
      arn = "arn:aws:s3:::spectra-tfstate-111122223333-us-east-1"
      id  = "spectra-tfstate-111122223333-us-east-1"
    }
  }

  override_resource {
    target          = aws_s3_bucket.audit
    override_during = plan
    values = {
      arn = "arn:aws:s3:::spectra-tfstate-audit-111122223333-us-east-1"
      id  = "spectra-tfstate-audit-111122223333-us-east-1"
    }
  }

  assert {
    condition     = length(aws_cloudtrail.state_audit.advanced_event_selector) == 1 && length(aws_cloudtrail.state_audit.event_selector) == 0
    error_message = "Un único selector avanzado; sin selectores clásicos."
  }

  assert {
    # Cada campo → [equals, starts_with, ends_with, not_equals, not_starts_with, not_ends_with], normalizado
    # (null o conjunto vacío = []). Exactamente 3 campos; sin readOnly, eventName ni otros filtros.
    condition = jsonencode({ for f in aws_cloudtrail.state_audit.advanced_event_selector[0].field_selector : f.field => [
      for k in ["equals", "starts_with", "ends_with", "not_equals", "not_starts_with", "not_ends_with"] : f[k] == null ? [] : tolist(f[k])
      ] }) == jsonencode({
      "eventCategory"  = [["Data"], [], [], [], [], []]
      "resources.type" = [["AWS::S3::Object"], [], [], [], [], []]
      "resources.ARN"  = [[], ["arn:aws:s3:::spectra-tfstate-111122223333-us-east-1/"], [], [], [], []]
    })
    error_message = "Solo eventos de datos de objetos S3 cuyo ARN empieza por el bucket del state (lectura y escritura: sin filtro readOnly; el bucket de auditoría queda fuera)."
  }

  assert {
    condition     = !strcontains(jsonencode(aws_cloudtrail.state_audit.advanced_event_selector), "spectra-tfstate-audit")
    error_message = "El trail no registra el bucket de auditoría (evita registrar sus propias entregas)."
  }

  assert {
    condition = alltrue([
      aws_cloudtrail.state_audit.name == "spectra-tfstate-audit",
      aws_cloudtrail.state_audit.enable_logging == true,
      aws_cloudtrail.state_audit.enable_log_file_validation == true,
      aws_cloudtrail.state_audit.is_multi_region_trail == false,
      aws_cloudtrail.state_audit.include_global_service_events == false,
    ])
    error_message = "Trail activo, con validación de integridad, de una región y sin eventos globales."
  }

  assert {
    condition     = aws_cloudtrail.state_audit.kms_key_id == aws_kms_key.state.arn && aws_cloudtrail.state_audit.s3_bucket_name == "spectra-tfstate-audit-111122223333-us-east-1"
    error_message = "Los registros se cifran con la CMK del state (D5) y se entregan al bucket de auditoría."
  }
}

run "audit_bucket_is_private_retained_and_undeletable" {
  command = plan

  override_resource {
    target          = aws_s3_bucket.audit
    override_during = plan
    values = {
      arn = "arn:aws:s3:::spectra-tfstate-audit-111122223333-us-east-1"
      id  = "spectra-tfstate-audit-111122223333-us-east-1"
    }
  }

  assert {
    condition     = aws_s3_bucket.audit.bucket == "spectra-tfstate-audit-111122223333-us-east-1"
    error_message = "Bucket de auditoría propio, distinto del bucket del state."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.audit.block_public_acls,
      aws_s3_bucket_public_access_block.audit.block_public_policy,
      aws_s3_bucket_public_access_block.audit.ignore_public_acls,
      aws_s3_bucket_public_access_block.audit.restrict_public_buckets,
    ])
    error_message = "El bucket de auditoría bloquea todo acceso público."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.audit.rule).object_ownership == "BucketOwnerEnforced" && one(aws_s3_bucket_versioning.audit.versioning_configuration).status == "Enabled"
    error_message = "Bucket de auditoría sin ACL y versionado."
  }

  assert {
    condition = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.audit.rule : (
      one(r.apply_server_side_encryption_by_default).sse_algorithm == "aws:kms"
    && one(r.apply_server_side_encryption_by_default).kms_master_key_id == aws_kms_key.state.arn)])
    error_message = "El bucket de auditoría cifra con SSE-KMS y la CMK del state (D5)."
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.audit.rule : r.bucket_key_enabled == false])
    error_message = "Sin S3 Bucket Key en el bucket de auditoría: AWS documenta que entonces crear el trail exige kms:Decrypt (D5: solo cifra)."
  }

  assert {
    condition = alltrue([for r in aws_s3_bucket_lifecycle_configuration.audit.rule : (
      r.status == "Enabled" && one(r.expiration).days == 365 && one(r.noncurrent_version_expiration).noncurrent_days == 365
    )])
    error_message = "D8: 365 días para la versión actual y para las anteriores (un borrado no acorta la retención)."
  }

  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.audit_bucket.statement : (
      s.sid == "DenyAuditLogVersionDeletion" && s.effect == "Deny" && toset(s.actions) == toset(["s3:DeleteObjectVersion"])
      && toset(s.resources) == toset(["arn:aws:s3:::spectra-tfstate-audit-111122223333-us-east-1/*"])
      && anytrue([for p in s.principals : p.type == "*" && toset(p.identifiers) == toset(["*"])])
    )])
    error_message = "Nadie (ningún principal) puede borrar versiones de los registros de auditoría."
  }

  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.audit_bucket.statement : (
      s.sid == "DenyInsecureTransport" && s.effect == "Deny"
    )])
    error_message = "El bucket de auditoría deniega el acceso sin TLS."
  }

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.audit_bucket.statement : (
      anytrue([for c in s.condition : c.variable == "aws:SourceArn" && toset(c.values) == toset(["arn:aws:cloudtrail:us-east-1:111122223333:trail/spectra-tfstate-audit"])])
    ) if anytrue([for p in s.principals : p.type == "Service"])])
    error_message = "CloudTrail solo puede entregar registros de este trail (aws:SourceArn)."
  }

  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.audit_bucket.statement : s.actions if s.effect != "Deny"])) == toset([
      "s3:GetBucketAcl", "s3:PutObject",
    ])
    error_message = "La política del bucket de auditoría solo concede a CloudTrail GetBucketAcl y PutObject."
  }
}

run "state_key_lets_only_the_audit_trail_encrypt" {
  command = plan

  assert {
    condition = alltrue([for s in data.aws_iam_policy_document.state_key.statement : (
      toset(flatten([for c in s.condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:cloudtrail:us-east-1:111122223333:trail/spectra-tfstate-audit"])
    ) if anytrue([for p in s.principals : contains(p.identifiers, "cloudtrail.amazonaws.com")])])
    error_message = "D5: CloudTrail solo usa la CMK del state para el trail de auditoría del state (aws:SourceArn)."
  }

  assert {
    condition = toset(flatten([for s in data.aws_iam_policy_document.state_key.statement : s.actions if anytrue([
      for p in s.principals : contains(p.identifiers, "cloudtrail.amazonaws.com")
    ])])) == toset(["kms:GenerateDataKey*", "kms:DescribeKey"])
    error_message = "D5: CloudTrail solo cifra (GenerateDataKey) y describe la clave; nunca descifra."
  }

  assert {
    condition = anytrue([for s in data.aws_iam_policy_document.state_key.statement : (
      anytrue([for c in s.condition : c.variable == "kms:EncryptionContext:aws:cloudtrail:arn" && toset(c.values) == toset(["arn:aws:cloudtrail:us-east-1:111122223333:trail/spectra-tfstate-audit"])])
    )])
    error_message = "D5: el cifrado exige el contexto del trail de auditoría del state."
  }
}

run "account_budget_exists_before_billable_resources" {
  command = plan

  assert {
    condition     = aws_budgets_budget.account.name == "spectra-account-monthly" && aws_budgets_budget.account.limit_amount == "50.00" && aws_budgets_budget.account.time_unit == "MONTHLY"
    error_message = "D7: presupuesto mensual de la cuenta de 50 USD (aviso, no tope)."
  }

  assert {
    condition     = length(aws_budgets_budget.account.notification) == 3 && alltrue([for n in aws_budgets_budget.account.notification : toset(n.subscriber_email_addresses) == toset(["owner@example.invalid"])])
    error_message = "D7: avisos al 50 % y 100 % del gasto real y al 100 % del pronóstico, a los destinatarios configurados."
  }

  assert {
    condition = (
      one(aws_budgets_budget.account.cost_types).include_credit == false
      && one(aws_budgets_budget.account.cost_types).include_refund == false
    )
    error_message = "D7: el presupuesto no descuenta créditos ni reembolsos (avisaría tarde o nunca)."
  }

  assert {
    condition = alltrue([
      one(aws_budgets_budget.account.cost_types).include_discount,
      one(aws_budgets_budget.account.cost_types).include_other_subscription,
      one(aws_budgets_budget.account.cost_types).include_recurring,
      one(aws_budgets_budget.account.cost_types).include_subscription,
      one(aws_budgets_budget.account.cost_types).include_support,
      one(aws_budgets_budget.account.cost_types).include_tax,
      one(aws_budgets_budget.account.cost_types).include_upfront,
      !one(aws_budgets_budget.account.cost_types).use_amortized,
      !one(aws_budgets_budget.account.cost_types).use_blended,
    ])
    error_message = "D7: el resto de los tipos de costo conserva los valores por defecto de AWS."
  }
}

run "rejects_bootstrap_without_budget_recipients" {
  command = plan

  variables {
    budget_emails = []
  }

  expect_failures = [var.budget_emails]
}

run "rejects_audit_retention_below_365_days" {
  command = plan

  variables {
    audit_log_retention_days = 90
  }

  expect_failures = [var.audit_log_retention_days]
}
