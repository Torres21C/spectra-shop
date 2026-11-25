# IAM preparado para el laboratorio AWS

Artefactos locales; **no crean ni asignan IAM**. Requieren aprobación separada y validación en IAM Access
Analyzer/Policy Simulator antes de usarse.

## Inventario y boundary

`environments/lab` crea 12 roles: 10 ejecuciones ECS, 1 tarea `identity` y 1 VPC Flow Logs. Todos exigen el
ARN fijo `arn:aws:iam::<cuenta>:policy/spectra-lab-runtime-boundary`. `permissions-boundary.json` limita el
máximo a ECR pull, escritura de logs, lectura de secretos y las operaciones KMS runtime. La policy inline de
cada rol sigue reduciendo recursos, algoritmos y `ViaService`; ambos controles deben permitir una acción.

La boundary se crea una vez fuera de los states `bootstrap`, `publisher` y `lab`. Las políticas preparadas
deniegan crear versiones, seleccionar versiones, eliminar/sustituir la policy y retirar la asociación. Por
eso un actor que pueda cambiar una policy inline del rol no puede superar el máximo efectivo.

## Permission sets

- `spectra-lab-deployer`: `plan-policy.json` es la base de inventario, lectura del state y manejo del lock.
  Durante una fase autorizada se agrega una sola política inline, `deploy-policy.json` o
  `teardown-policy.json`. Cerrar la sesión anterior y verificar el cambio de permisos antes de operar.
- `spectra-lab-operator`: `operator-policy.json`, solo observación y tareas ECS aprobadas.

Los tokens `__ACCOUNT_ID__`, `__REGION__`, `__TFSTATE_BUCKET__`, `__STATE_KMS_KEY_ARN__` y
`__BOUNDARY_ARN__` deben sustituirse con valores comprobados. `policy-variables.example.json` documenta el
contrato; no es configuración real. Ninguna política contiene `AdministratorAccess` ni un `Allow Action:*`.

`deploy-policy.json` deniega API regionales fuera de `us-east-1`, exige `Project=spectra-shop`,
`Environment=lab` y `LabCycle` al crear recursos que admiten tag-on-create, y bloquea mutaciones cuando un
recurso declara tags de otro proyecto/entorno. KMS queda separado: `PutKeyPolicy` solo sobre claves lab
etiquetadas y `CreateGrant` exige además `kms:GrantIsForAWSResource=true`. S3 queda limitado al nombre exacto
`spectra-lab-spa-<cuenta>` porque `CreateBucket` no usa los tags del provider en la llamada de creación.

Algunas API de asociación, registro y recursos globales no exponen `aws:ResourceTag`/`aws:RequestTag`; para
conservar compatibilidad con Terraform se mantienen en la allowlist de `ManageExistingLabResources` con
`StringEqualsIfExists`. Los `DenyForeignProject` y `DenyForeignEnvironment` enumeran únicamente patrones que
Access Analyzer confirma compatibles con `aws:ResourceTag`; no declaran protección ficticia sobre acciones
que AWS no evalúa con esas claves. Esto no equivale a mínimo privilegio total por recurso. El plan
guardado/guard, los nombres fijos y la sesión corta siguen siendo controles compensatorios para las acciones
sin tags, que deben sustituirse por ARN/nombre exacto cuando la API lo admita antes del apply real.

## Instalación manual después de la autorización

1. Renderizar los JSON fuera del repositorio con la cuenta objetivo, `us-east-1`, el bucket y la CMK del
   state de bootstrap y el ARN exacto de la boundary. Validar con Access Analyzer y registrar los hashes.
2. En IAM → Policies → Create policy → JSON, crear `spectra-lab-runtime-boundary` y
   `spectra-lab-plan-base` desde los documentos renderizados respectivos. La segunda se referencia como
   política administrada por el cliente. Esta separación deja la política inline disponible para la fase
   activa. Comprobar antes de aprovisionar el límite de 10 240 bytes sin espacios de la política inline.
3. En IAM Identity Center (`us-east-1`) → Multi-account permissions → Permission sets → Create permission
   set → Custom permission set, crear `spectra-lab-deployer` con sesión de 2 horas. En Customer managed
   policies agregar `spectra-lab-plan-base`, path `/`. Dejar vacía la política inline en fase plan.
4. Repetir para `spectra-lab-operator`, sesión de 1 hora, con `operator-policy.json` como única política
   inline. En AWS accounts seleccionar la cuenta, elegir Assign users or groups y asignar cada conjunto
   exclusivamente a sus operadores autorizados.
5. Antes del plan real, comprobar identidad SSO, ARN de la boundary, acceso al prefijo de state y permisos
   KMS. Simular CreateRole sin boundary y con otra boundary, retirada, sustitución, modificación de
   versiones, y mutación y PassRole sobre el publicador. Exigir denegación en cada caso. Verificar que los
   roles preexistentes con nombres de ejecución del lab tengan la boundary exacta antes de habilitar deploy.
6. Para cambiar de fase, en el permission set editar Inline policy, pegar solo la fase aprobada y
   reprovisionar en AWS accounts → Update. Verificar política efectiva y abrir una sesión nueva. Al
   finalizar, quitar la política inline de fase, reprovisionar y confirmar la base.

La boundary se aplica a los roles runtime desde Terraform. Las políticas deploy/teardown acotan las
mutaciones IAM a los roles de ejecución, al rol de tarea Identity y a Flow Logs. Operator puede pasar
roles de ejecución a ECS. El publicador queda fuera de los tres ámbitos.

Referencias operativas: [creación de permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/howtocreatepermissionset.html)
y [cuotas de Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/limits.html).

## Secuencia sin circularidad

1. Ejecutar `python3 infra/terraform/scripts/validate_lab_iam.py` y las pruebas unitarias.
2. Crear/revisar la boundary por un canal aprobado; registrar ARN y SHA-256 del JSON. No la gestiona `lab`.
3. Asignar solo la variante `plan`; realizar inventario y plan local simulado/real de solo lectura.
4. Revisar JSON, guard y SHA del plan. Solo entonces cambiar temporalmente a `deploy`.
5. Para desmontar, volver a `plan`, validar `prepare` y `destroy`, y activar temporalmente `teardown`.
6. Verificar roles y residuos; cerrar la sesión. La boundary permanece.

El destroy puede revelar que AWS/Terraform requiere `DeleteRolePermissionsBoundary` antes de `DeleteRole`.
Ese permiso está denegado deliberadamente. Si ocurre, el proceso falla cerrado y requiere un cambio de diseño
aprobado; no se concede de forma preventiva.

## Pruebas de escalada

Para renderizar desde el state local de bootstrap y ejecutar el simulador de
AWS con el perfil de lectura, usar `infra/terraform/scripts/simulate_lab_iam.py`.
Pasar `--bootstrap-state` con la ruta privada del state y `--output` con una ruta
nueva fuera del repositorio. El directorio contendrá políticas renderizadas y
resultados privados. La simulación valida decisiones IAM concretas. Access
Analyzer, la política del bucket, KMS y los controles de cuenta requieren
comprobaciones adicionales antes de aprovisionar.

Resultado del 2026-11-24 sobre los documentos renderizados: **37/37** en
Policy Simulator y **cero hallazgos** en Access Analyzer para `deploy`. La matriz
incluye ahora los `Deny` de proyecto y entorno ajenos, además de la boundary, el
publicador y las negativas de teardown sobre bucket y presupuesto de bootstrap.
El resumen privado de la simulación tiene SHA-256
`e0b896beee0c2e973ff62ce8c5b951cf333823d6cfe60797457c1df062a3371a`.

`scripts/tests/test_lab_iam.py` comprueba localmente: creación de rol sin boundary, sustitución/retirada,
mutación de versiones, `PassRole` sin servicio/recurso acotado, combinación peligrosa durante teardown y
mutación IAM por operator. Son pruebas estructurales, no sustituyen IAM Policy Simulator ni una prueba AWS
con credenciales temporales y llamadas que deban devolver `AccessDenied`.

## Revisión Git

Preparar un PR de infraestructura desde el `main` aprobado con Terraform del laboratorio, módulos,
plantillas IAM, validadores, pruebas, ADR-AWS-07 y runbook. Separar guías y entregables académicos de los
cambios ejecutables. Los wrappers locales del publisher se revisan por separado y su destino depende del
flujo operativo aprobado. Excluir tfvars reales, políticas renderizadas, planes, states y logs crudos.
Revisar diffs y pruebas, pedir aprobación de ADR-AWS-07 y esperar autorización para push, PR y merge.
