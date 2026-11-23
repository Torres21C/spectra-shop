#!/usr/bin/env bash
# PR-7A: pruebas de paridad de seguridad de ECS Fargate en local (Docker Compose DESECHABLE, sin AWS).
#
# Uso (desde cualquier directorio):
#   SPECTRA_PARITY_PROJECT=spectra-pr7a-<sufijo> \
#   SPECTRA_PARITY_IMAGE_PREFIX=spectra-pr7a SPECTRA_PARITY_IMAGE_TAG=<etiqueta> \
#   scripts/ecs-parity/run-parity-tests.sh <directorio-de-trabajo> <directorio-de-evidencias>
#
# - Las 9 imágenes deben existir ya en Docker como <prefijo>/<nombre>:<etiqueta> (las de un artefacto
#   `ecr-release` de la CI, verificadas con `release_tool.py verify-release` y cargadas con `docker load`).
# - El directorio de trabajo (credenciales efímeras, CA de prueba, configuración renderizada) y el de
#   evidencias deben estar FUERA del repositorio. Las evidencias se redactan (ningún valor secreto).
# - Exige un proyecto Compose NUEVO: nunca reutiliza ni borra volúmenes (el script no ejecuta `down -v`).
#   Al terminar, detiene el proyecto (`stop`) y conserva contenedores y volúmenes para su revisión.
# - No usa credenciales AWS: KMS es el emulador local-kms en la red interna.
set -euo pipefail

WORK=${1:?Uso: run-parity-tests.sh <dir-trabajo> <dir-evidencias>}
OUT=${2:?Uso: run-parity-tests.sh <dir-trabajo> <dir-evidencias>}
P=${SPECTRA_PARITY_PROJECT:?Defina SPECTRA_PARITY_PROJECT=spectra-pr7a-<sufijo>}
PREFIX=${SPECTRA_PARITY_IMAGE_PREFIX:?Defina SPECTRA_PARITY_IMAGE_PREFIX}
TAG=${SPECTRA_PARITY_IMAGE_TAG:?Defina SPECTRA_PARITY_IMAGE_TAG}
PORT_BASE=${SPECTRA_PARITY_PORT_BASE:-4300}
READY_TIMEOUT=${SPECTRA_PARITY_READY_TIMEOUT:-300}
ORIGIN=https://parity.spectra.test

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../.." && pwd)
CHECKS="python3 -I $SCRIPT_DIR/parity_checks.py"
SERVICES="identity-service catalog-service commerce-service audit-service"
JOBS="postgres-provision identity-migrate catalog-migrate commerce-migrate audit-migrate postgres-finalize"
IMAGES="identity-service-runtime identity-service-migrate catalog-service-runtime catalog-service-migrate commerce-service-runtime commerce-service-migrate audit-service-runtime audit-service-migrate db-ops"

die() { echo "FATAL: $*" >&2; exit 2; }

# ----------------------------------------------------------------------------------------------- guardas
case "$P" in spectra-pr7a-*) ;; *) die "el proyecto debe llamarse spectra-pr7a-<sufijo> (nunca spectra-shop)" ;; esac
echo "$P" | grep -Eq '^spectra-pr7a-[a-z0-9-]+$' || die "nombre de proyecto no válido: $P"
mkdir -p "$WORK" "$OUT"
WORK=$(cd "$WORK" && pwd); OUT=$(cd "$OUT" && pwd)
case "$WORK/" in "$REPO"/*) die "el directorio de trabajo no puede estar dentro del repositorio" ;; esac
case "$OUT/" in "$REPO"/*) die "el directorio de evidencias no puede estar dentro del repositorio" ;; esac
[ -z "$(ls -A "$OUT")" ] || die "el directorio de evidencias debe estar vacío: $OUT"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$P")" ] ||
  die "el proyecto $P ya tiene volúmenes: use un proyecto nuevo (este script nunca borra volúmenes)"
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$P")" ] || die "el proyecto $P ya tiene contenedores"
for img in $IMAGES; do
  docker image inspect "$PREFIX/$img:$TAG" >/dev/null 2>&1 || die "falta la imagen $PREFIX/$img:$TAG"
done

umask 077
chmod 700 "$WORK" "$OUT"
mkdir -p "$WORK/tls" "$WORK/no-keys" "$OUT/00-configuracion" "$OUT/10-arranque" "$OUT/20-positivas" \
  "$OUT/30-negativas" "$OUT/40-recuperacion" "$OUT/50-logs"
ENVF="$WORK/parity.env"
RESULTS="$OUT/resultados.tsv"
printf 'id\tprueba\tesperado\tobtenido\tveredicto\n' > "$RESULTS"
FAILS=0
rec() { # id prueba esperado obtenido ok(0|1)
  local verdict=PASS
  [ "$5" = 0 ] || { verdict=FAIL; FAILS=$((FAILS + 1)); }
  # Sin tabuladores ni saltos de línea dentro de los campos (TSV de una línea por prueba).
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(printf '%s' "$4" | tr '\t\n' '  ')" "$verdict" >> "$RESULTS"
  printf '%-6s %-4s %s -> %s\n' "$1" "$verdict" "$2" "$4"
}

dc() {
  (cd "$REPO" && docker compose -p "$P" --env-file "$ENVF" \
    -f compose.yaml -f infra/postgres/rds-emulation/compose.rds-emulation.yaml \
    -f infra/ecs-parity/compose.ecs-parity.yaml "$@")
}
port_of() { case "$1" in identity-service) echo "${PORT_BASE}1" ;; catalog-service) echo "${PORT_BASE}2" ;;
  commerce-service) echo "${PORT_BASE}3" ;; audit-service) echo "${PORT_BASE}4" ;; esac; }
http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }
cid() { dc ps -a -q "$1" | head -1; }

# ----------------------------------------------------------------------------- credenciales y CA efímeras
hex() { openssl rand -hex "$1"; }
INTERNAL_TOKEN=$(hex 32); INVENTORY_TOKEN=$(hex 32)
cat > "$ENVF" <<EOF
POSTGRES_DB=spectra_parity
POSTGRES_USER=parity_cluster_admin
POSTGRES_PASSWORD=$(hex 32)
RDS_MASTER_PASSWORD=$(hex 32)
SPECTRA_IDENTITY_MIGRATOR_PASSWORD=$(hex 32)
SPECTRA_IDENTITY_APP_PASSWORD=$(hex 32)
SPECTRA_CATALOG_MIGRATOR_PASSWORD=$(hex 32)
SPECTRA_CATALOG_APP_PASSWORD=$(hex 32)
SPECTRA_COMMERCE_MIGRATOR_PASSWORD=$(hex 32)
SPECTRA_COMMERCE_APP_PASSWORD=$(hex 32)
SPECTRA_AUDIT_MIGRATOR_PASSWORD=$(hex 32)
SPECTRA_AUDIT_APP_PASSWORD=$(hex 32)
SPECTRA_INTERNAL_TOKEN=$INTERNAL_TOKEN
SPECTRA_INTERNAL_TOKENS=$INTERNAL_TOKEN
CATALOG_INVENTORY_TOKEN=$INVENTORY_TOKEN
CATALOG_INVENTORY_TOKENS=$INVENTORY_TOKEN
SYNTHETIC_ADMIN_EMAIL=parity.admin@example.test
SYNTHETIC_ADMIN_PASSWORD=$(hex 24)
SPECTRA_KEYS_DIR=$WORK/no-keys
SPECTRA_PARITY_IMAGE_PREFIX=$PREFIX
SPECTRA_PARITY_IMAGE_TAG=$TAG
SPECTRA_PARITY_TLS_DIR=$WORK/tls
SPECTRA_PARITY_PUBLIC_ORIGIN=$ORIGIN
SPECTRA_PARITY_IDENTITY_PORT=${PORT_BASE}1
SPECTRA_PARITY_CATALOG_PORT=${PORT_BASE}2
SPECTRA_PARITY_COMMERCE_PORT=${PORT_BASE}3
SPECTRA_PARITY_AUDIT_PORT=${PORT_BASE}4
EOF
chmod 600 "$ENVF"
# shellcheck disable=SC1090
set -a; . "$ENVF"; set +a

# CA de prueba RSA (LibreSSL de macOS genera EC con parámetros explícitos que OpenSSL 3 rechaza) y certificado
# del servidor para el nombre `postgres`; una segunda CA para las pruebas negativas.
T="$WORK/tls"
openssl req -x509 -sha256 -newkey rsa:2048 -nodes -days 2 -subj "/CN=PR-7A parity test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$T/ca.key" -out "$T/ca.crt" 2>/dev/null
openssl req -sha256 -newkey rsa:2048 -nodes -subj "/CN=postgres" -keyout "$T/server.key" -out "$T/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:postgres\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$T/san.ext"
openssl x509 -req -sha256 -in "$T/server.csr" -CA "$T/ca.crt" -CAkey "$T/ca.key" -CAcreateserial -days 2 \
  -extfile "$T/san.ext" -out "$T/server.crt" 2>/dev/null
openssl req -x509 -sha256 -newkey rsa:2048 -nodes -days 2 -subj "/CN=PR-7A other CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$T/other.key" -out "$T/other.crt" 2>/dev/null
# Montajes de solo lectura: el contenedor de PostgreSQL copia la clave con su propio dueño y modo 600.
chmod 0644 "$T/server.crt" "$T/server.key" "$T/ca.crt" "$T/other.crt"
chmod 0755 "$T"
openssl x509 -in "$T/server.crt" -noout -subject -issuer -ext subjectAltName -dates > "$OUT/00-configuracion/certificado-servidor.txt" 2>&1 || true

# ------------------------------------------------------------------------------------- KMS emulado
export SPECTRA_PARITY_KMS_KEY_ARN=pendiente KMS_PUBLIC_KEY_PEM=pendiente
echo "== KMS emulado"
dc up -d --pull never kms >/dev/null
sleep 2
dc --profile parity-setup run --rm --pull never kms-seed > "$WORK/kms-seed.out" 2> "$WORK/kms-seed.err" </dev/null ||
  { cat "$WORK/kms-seed.err" >&2; die "kms-seed falló"; }
cp "$WORK/kms-seed.out" "$OUT/10-arranque/kms-seed.json"
KMS_LINES=$($CHECKS kms-env "$WORK/kms-seed.out")
SPECTRA_PARITY_KMS_KEY_ARN=$(printf '%s\n' "$KMS_LINES" | head -1)
KMS_PUBLIC_KEY_PEM="$(printf '%s\n' "$KMS_LINES" | tail -n +2)
"
export SPECTRA_PARITY_KMS_KEY_ARN KMS_PUBLIC_KEY_PEM
echo "SPECTRA_PARITY_KMS_KEY_ARN=$SPECTRA_PARITY_KMS_KEY_ARN" >> "$ENVF"
rec S-01 "Clave KMS emulada ECC_NIST_P256/SIGN_VERIFY con alias" "ARN del emulador y clave pública PEM" \
  "$(echo "$SPECTRA_PARITY_KMS_KEY_ARN" | sed 's#key/.*#key/…#')" 0

# ------------------------------------------------------------------------- configuración renderizada
dc config --format json > "$WORK/config.json"
if $CHECKS check-config "$WORK/config.json" > "$OUT/00-configuracion/comprobacion-configuracion.json"; then ok=0; else ok=1; fi
rec S-02 "Configuración renderizada = task definitions ECS" "0 diferencias" \
  "$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print("{}/{}".format(d["passed"], d["total"]))' "$OUT/00-configuracion/comprobacion-configuracion.json")" $ok
cp "$REPO/infra/ecs-parity/compose.ecs-parity.yaml" "$SCRIPT_DIR/run-parity-tests.sh" "$SCRIPT_DIR/kms-seed.mjs" \
  "$SCRIPT_DIR/parity_checks.py" "$OUT/00-configuracion/"
cut -d= -f1 "$ENVF" > "$OUT/00-configuracion/variables-entorno-nombres.txt"  # solo nombres, nunca valores
{
  echo "fecha_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo_head=$(git -C "$REPO" rev-parse HEAD)"
  echo "repo_rama=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  echo "repo_cambios_sin_commit=$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
  echo "proyecto_compose=$P"
  echo "docker=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  echo "compose=$(docker compose version --short)"
  echo "host=$(uname -sm)"
  echo "node_host=$(node --version)"
  echo "openssl=$(openssl version)"
  for img in $IMAGES; do
    echo "imagen $PREFIX/$img:$TAG id=$(docker image inspect --format '{{.Id}}' "$PREFIX/$img:$TAG") plataforma=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$PREFIX/$img:$TAG") usuario=$(docker image inspect --format '{{.Config.User}}' "$PREFIX/$img:$TAG")"
  done
  echo "imagen postgres=$(docker image inspect --format '{{.Id}}' postgres:16.6-alpine)"
  echo "imagen local-kms=$(docker image inspect --format '{{.Id}}' nsmithuk/local-kms:3.12.0)"
} > "$OUT/00-configuracion/versiones-y-digests.txt"

# ------------------------------------------------------------------------------------------- arranque
echo "== Arranque: postgres → provision → 4 migraciones → finalize → 4 servicios"
START_TS=$(date +%s)
dc up -d --no-build --pull never $SERVICES > "$OUT/10-arranque/compose-up.log" 2>&1 || {
  cat "$OUT/10-arranque/compose-up.log" >&2; dc logs --no-color > "$OUT/50-logs/todo-fallo-arranque.log" 2>&1 || true; }
for job in $JOBS; do
  c=$(cid "$job"); code=$(docker inspect --format '{{.State.ExitCode}}' "$c" 2>/dev/null || echo ausente)
  dc logs --no-color "$job" > "$OUT/10-arranque/$job.log" 2>&1 || true
  rec "P-01" "Tarea $job (run-task equivalente)" "exitCode=0" "exitCode=$code" "$([ "$code" = 0 ] && echo 0 || echo 1)"
done

deadline=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  all=1
  for s in $SERVICES; do
    h=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(cid "$s")" 2>/dev/null || echo none)
    [ "$h" = healthy ] || all=0
  done
  [ $all = 1 ] && break
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 5
done
echo "segundos_hasta_healthy=$(( $(date +%s) - START_TS ))" >> "$OUT/10-arranque/tiempos.txt"
STATE_BEFORE="$WORK/state-before.txt"; : > "$STATE_BEFORE"
for s in $SERVICES; do
  c=$(cid "$s")
  st=$(docker inspect --format '{{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$c")
  echo "$s $st" >> "$STATE_BEFORE"
  case "$st" in "running health=healthy restarts=0 "*) ok=0 ;; *) ok=1 ;; esac
  rec P-02 "$s arranca bajo las restricciones" "running, healthy, 0 reinicios" "${st% started=*}" $ok
done
cp "$STATE_BEFORE" "$OUT/10-arranque/estado-servicios.txt"
for s in $SERVICES; do dc logs --no-color "$s" > "$OUT/10-arranque/$s-arranque.log" 2>&1 || true; done

# ------------------------------------------------------------------------------------------ positivas
echo "== Pruebas positivas"
for s in $SERVICES; do
  port=$(port_of "$s")
  for path in /health /health/ready; do
    code=$(http_code "http://127.0.0.1:$port$path")
    rec P-03 "$s GET $path" 200 "$code" "$([ "$code" = 200 ] && echo 0 || echo 1)"
  done
done

run_smoke() { # archivo
  SPECTRA_E2E_IDENTITY_URL="http://127.0.0.1:$(port_of identity-service)" \
  SPECTRA_E2E_CATALOG_URL="http://127.0.0.1:$(port_of catalog-service)" \
  SPECTRA_E2E_COMMERCE_URL="http://127.0.0.1:$(port_of commerce-service)" \
  SPECTRA_E2E_AUDIT_URL="http://127.0.0.1:$(port_of audit-service)" \
  SPECTRA_E2E_ORIGIN="$ORIGIN" \
  SPECTRA_E2E_ADMIN_EMAIL="$SYNTHETIC_ADMIN_EMAIL" SPECTRA_E2E_ADMIN_PASSWORD="$SYNTHETIC_ADMIN_PASSWORD" \
    node "$REPO/scripts/mvp-e2e-smoke.mjs" > "$1" 2>&1
}
if run_smoke "$OUT/20-positivas/smoke-e2e.json"; then ok=0; else ok=1; fi
summary=$($CHECKS smoke-summary "$OUT/20-positivas/smoke-e2e.json" || true)
echo "$summary" > "$OUT/20-positivas/smoke-resumen.json"
rec P-04 "Smoke E2E con ADMIN (KMS, cookies Secure, CORS https)" "11/11 PASS" \
  "$(python3 -I -c 'import json,sys;d=json.loads(sys.argv[1]);print("{}/{} {}".format(d["steps_passed"], d["steps_total"], d["verdict"]))' "$summary" 2>/dev/null || echo error)" \
  "$(echo "$summary" | grep -q '"steps_passed": 11, ' && echo "$summary" | grep -q '"steps_total": 11' && [ $ok = 0 ] && echo 0 || echo 1)"

echo "== DT-09 (verificador con verify-full contra la CA de prueba)"
dc --profile test build db-isolation-test > "$OUT/20-positivas/dt09-build.log" 2>&1 || true
if dc --profile test run --rm --no-deps db-isolation-test > "$OUT/20-positivas/dt09.log" 2>&1 </dev/null; then ok=0; else ok=1; fi
dt09=$($CHECKS dt09-summary "$OUT/20-positivas/dt09.log" || true)
rec P-05 "DT-09 aislamiento PostgreSQL (maestro RDS emulado, TLS)" "492/492" \
  "$(python3 -I -c 'import json,sys;d=json.loads(sys.argv[1]);print("{}/{}".format(d["passed"], d["total"]))' "$dt09" 2>/dev/null || echo error)" \
  "$(echo "$dt09" | grep -q '"total": 492, "passed": 492, "failed": 0' && [ $ok = 0 ] && echo 0 || echo 1)"

echo "== TLS de PostgreSQL"
PG=$(cid postgres)
psql_admin() { docker exec -u postgres "$PG" psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"; }
psql_admin "show ssl; show ssl_min_protocol_version; show log_statement; show log_min_duration_statement;" \
  > "$OUT/20-positivas/tls-servidor.txt" 2>&1
psql_admin "select a.usename, s.ssl, s.version, s.cipher, count(*) from pg_stat_activity a join pg_stat_ssl s using (pid) where a.backend_type = 'client backend' and a.client_addr is not null group by 1,2,3,4 order by 1" \
  > "$OUT/20-positivas/tls-conexiones.txt" 2>&1
nossl=$(awk -F'|' '$2 != "t"' "$OUT/20-positivas/tls-conexiones.txt" | wc -l | tr -d ' ')
roles=$(awk -F'|' '$2 == "t" && $1 ~ /^spectra_.*_app$/ {print $1}' "$OUT/20-positivas/tls-conexiones.txt" | sort -u | wc -l | tr -d ' ')
rec P-06 "Conexiones TCP de los 4 servicios cifradas" "4 roles *_app con ssl=t; 0 sin TLS" "roles_tls=$roles sin_tls=$nossl" \
  "$([ "$roles" = 4 ] && [ "$nossl" = 0 ] && echo 0 || echo 1)"
PG_SETTINGS_REPORT="$OUT/20-positivas/tls-servidor-comprobacion.json"
$CHECKS pg-settings "$OUT/20-positivas/tls-servidor.txt" > "$PG_SETTINGS_REPORT" || true
pg_setting_rec() { # id nombre esperado
  local actual ok
  actual=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(next(c["actual"] for c in d["checks"] if c["name"] == sys.argv[2]))' "$PG_SETTINGS_REPORT" "$2" 2>/dev/null || echo ausente)
  [ "$actual" = "$3" ] && ok=0 || ok=1
  rec "$1" "PostgreSQL $2" "$3" "$actual" "$ok"
}
pg_setting_rec P-06b1 "ssl" "on"
pg_setting_rec P-06b2 "ssl_min_protocol_version" "TLSv1.2"
pg_setting_rec P-06b3 "log_statement" "none"
pg_setting_rec P-06b4 "log_min_duration_statement" "-1"

pg_client() { # descripción esperado(conecta|rechaza) conninfo
  local out rc got
  out=$(docker run --rm --platform linux/amd64 --read-only --cap-drop ALL --network "${P}_backend" -v "$T:/ca:ro" \
    -e PGPASSWORD="$SPECTRA_CATALOG_APP_PASSWORD" "$PREFIX/db-ops:$TAG" \
    psql -X -At "$3" -c "select 'ssl=' || ssl || ' ' || version from pg_stat_ssl where pid = pg_backend_pid()" </dev/null 2>&1) && rc=0 || rc=$?
  if [ $rc = 0 ]; then got=conecta; elif [ $rc = 2 ] && echo "$out" | grep -q 'psql: error'; then got=rechaza; else got="error-de-prueba(rc=$rc)"; fi
  printf '%s\t%s\t%s\n' "$1" "$got" "$(echo "$out" | tail -1 | sed "s/$SPECTRA_CATALOG_APP_PASSWORD/***/g" | cut -c1-200)" >> "$OUT/20-positivas/tls-clientes.tsv"
  rec P-07 "$1" "$2" "$got" "$([ "$got" = "$2" ] && echo 0 || echo 1)"
}
printf 'caso\tresultado\tdetalle\n' > "$OUT/20-positivas/tls-clientes.tsv"
BASECONN="host=postgres dbname=$POSTGRES_DB user=spectra_catalog_app"
pg_client "psql sslmode=require (como ECS)" conecta "$BASECONN sslmode=require"
pg_client "psql verify-full con la CA de prueba" conecta "$BASECONN sslmode=verify-full sslrootcert=/ca/ca.crt"
pg_client "psql sslmode=disable (rds.force_ssl)" rechaza "$BASECONN sslmode=disable"
pg_client "psql verify-full con otra CA" rechaza "$BASECONN sslmode=verify-full sslrootcert=/ca/other.crt"

dc logs --no-color kms > "$OUT/20-positivas/kms-emulador.log" 2>&1 || true
signs=$(grep -ci 'sign' "$OUT/20-positivas/kms-emulador.log" || true)
rec P-08 "Firma de JWT con KMS (emulado) y verificación con la clave pública" "llamadas Sign en el emulador > 0 y smoke PASS" "lineas_sign=$signs" \
  "$([ "${signs:-0}" -gt 0 ] && echo 0 || echo 1)"

# ------------------------------------------------------------------------------------------ negativas
echo "== Pruebas negativas (dentro de cada contenedor de servicio, con su usuario y capacidades)"
set +e  # el análisis usa grep/awk que devuelven 1 sin coincidencias; cada veredicto se decide con rec
# Solo órdenes internas del shell para localizar el proceso: `pidof` (binario x86 emulado) aborta con raíz de
# solo lectura en Docker Desktop/Rosetta (ver la prueba X-01).
PROBE='
set +e
echo "## identidad"; id
echo "## pid1"; read -r c1 < /proc/1/comm; echo "$c1"
APP=""
for d in /proc/[0-9]*; do
  read -r c < "$d/comm" 2>/dev/null || continue
  n=${d#/proc/}
  if [ "$c" = node ] && { [ -z "$APP" ] || [ "$n" -lt "$APP" ]; }; then APP=$n; fi
done
echo "## proceso_app pid=$APP"; grep -E "^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):" "/proc/$APP/status"
echo "## montaje_raiz"; awk "\$2 == \"/\" {print \$4}" /proc/mounts | cut -d, -f1
echo "## montajes_rw"; awk "\$4 ~ /^rw/ {print \$2\" \"\$3}" /proc/mounts
echo "## escritura"
for p in / /app /app/dist /app/node_modules /tmp /var/tmp /home/node /etc /usr/local/bin /usr/local/lib /var/log /run /root /dev /dev/shm /dev/mqueue; do
  msg=$(touch "$p/.pr7a-probe" 2>&1); rc=$?
  if [ $rc = 0 ]; then rm -f "$p/.pr7a-probe"; echo "$p|ESCRIBIBLE|"; else echo "$p|DENEGADO|$msg"; fi
done
echo "## setuid_setgid_usuario_node"; find / -xdev \( -perm -4000 -o -perm -2000 \) -type f 2>&1 | grep -v "Permission denied"; echo "fin"
echo "## escalada"
node -e "try{process.setuid(0);console.log(\"setuid0|ESCALADO\")}catch(e){console.log(\"setuid0|\"+e.code)}"
node -e "try{process.setgid(0);console.log(\"setgid0|ESCALADO\")}catch(e){console.log(\"setgid0|\"+e.code)}"
f=/dev/shm/.pr7a-chown; : > $f 2>/dev/null
m=$(chown 0:0 $f 2>&1) && echo "chown_root|PERMITIDO" || echo "chown_root|$m"
rm -f $f
m=$(mknod /dev/shm/.pr7a-null c 1 3 2>&1) && { echo "mknod|PERMITIDO"; rm -f /dev/shm/.pr7a-null; } || echo "mknod|$m"
m=$(su -c id root </dev/null 2>&1) && echo "su_root|PERMITIDO" || echo "su_root|$m"
echo "## restos"; ls -A /dev/shm /dev/mqueue
'
section() { awk -v h="## $2" '$0 == h {w=1; next} /^## / {w=0} w' "$1"; }
for s in $SERVICES; do
  f="$OUT/30-negativas/$s-sonda.txt"
  docker exec "$(cid "$s")" sh -c "$PROBE" > "$f" 2>&1
  writable=$(section "$f" escritura | awk -F'|' '$2 == "ESCRIBIBLE" {print $1}' | tr '\n' ' ')
  denied=$(section "$f" escritura | awk -F'|' '$2 == "DENEGADO"' | wc -l | tr -d ' ')
  rofs=$(section "$f" escritura | grep -c 'Read-only file system')
  # /dev/shm y /dev/mqueue: tmpfs/mqueue que Docker monta siempre (fuera de la raíz); se documentan como
  # rutas escribibles conocidas. Cualquier otra ruta escribible es un fallo.
  unexpected=$(echo "$writable" | tr ' ' '\n' | grep -v -e '^$' -e '^/dev/shm$' -e '^/dev/mqueue$' | tr '\n' ' ')
  rec N-01 "$s: escritura en la raíz, /tmp, /app, /home/node, /etc, /dev…" "14 de 16 rutas denegadas; solo /dev/shm y /dev/mqueue (montajes de Docker)" \
    "denegadas=$denied erofs=$rofs escribibles=[${writable% }]" "$([ -z "$unexpected" ] && [ "$denied" = 14 ] && echo 0 || echo 1)"
  root_mode=$(section "$f" montaje_raiz | head -1)
  rec N-02 "$s: sistema de archivos raíz" "ro" "$root_mode" "$([ "$root_mode" = ro ] && echo 0 || echo 1)"
  uid=$(section "$f" identidad | head -1 | sed 's/ groups=.*//')
  rec N-03 "$s: usuario no privilegiado" "uid=1000(node)" "$uid" "$(echo "$uid" | grep -q '^uid=1000(node) gid=1000(node)$' && echo 0 || echo 1)"
  app=$(grep -E '^## proceso_app pid=' "$f" | sed 's/.*pid=//')
  caps=$(grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb):' "$f" | awk '{print $2}' | sort -u | tr '\n' ' ')
  ncaps=$(grep -c -E '^Cap(Inh|Prm|Eff|Bnd|Amb):' "$f")
  nnp=$(grep -E '^NoNewPrivs:' "$f" | awk '{print $2}')
  rec N-04 "$s: capacidades del proceso node (pid $app)" "Inh/Prm/Eff/Bnd/Amb = 0" "campos=$ncaps valores=[${caps% }] NoNewPrivs=$nnp" \
    "$([ "$ncaps" = 5 ] && [ "${caps% }" = 0000000000000000 ] && echo 0 || echo 1)"
  img="$PREFIX/${s}-runtime:$TAG"
  rootscan=$(docker run --rm --pull never --platform linux/amd64 -u 0 --entrypoint sh "$img" -c \
    'find / -xdev \( -perm -4000 -o -perm -2000 \) -type f; echo "rc=$?"' </dev/null 2>&1)
  printf '%s\n' "$rootscan" > "$OUT/30-negativas/$s-setuid-escaneo-root.txt"
  suid_node=$(section "$f" setuid_setgid_usuario_node | grep -v -e '^fin$' -e '^$' | wc -l | tr -d ' ')
  suid_root=$(echo "$rootscan" | grep -v -e '^rc=' -e '^$' | wc -l | tr -d ' ')
  rec N-05 "$s: binarios setuid/setgid (como node y escaneo completo como root)" "0 y 0" "$suid_node y $suid_root ($(echo "$rootscan" | tail -1))" \
    "$([ "$suid_node" = 0 ] && [ "$suid_root" = 0 ] && echo "$rootscan" | tail -1 | grep -q '^rc=0$' && echo 0 || echo 1)"
  esc=$(section "$f" escalada | tr '\n' ';')
  nesc=$(section "$f" escalada | wc -l | tr -d ' ')
  bad=$(echo "$esc" | grep -c -e 'ESCALADO' -e 'PERMITIDO')
  rec N-06 "$s: escalada (setuid/setgid 0, chown root, mknod, su)" "5 intentos, todos rechazados" "$(echo "$esc" | cut -c1-230)" \
    "$([ "$nesc" = 5 ] && [ "$bad" = 0 ] && echo 0 || echo 1)"
  pid1=$(section "$f" pid1 | head -1)
  rec N-07 "$s: PID 1 = proceso init (initProcessEnabled)" docker-init "$pid1" "$([ "$pid1" = docker-init ] && echo 0 || echo 1)"
  restos=$(section "$f" restos | grep -v -e '^/dev/' -e '^$' | wc -l | tr -d ' ')
  rec N-07b "$s: la sonda no deja archivos" 0 "$restos" "$([ "$restos" = 0 ] && echo 0 || echo 1)"
done

# Control: la misma imagen SIN las restricciones sí puede escribir; demuestra que el bloqueo viene de la
# configuración de paridad y no de la imagen.
CTRL=$(docker run --rm --pull never --platform linux/amd64 --entrypoint sh "$PREFIX/identity-service-runtime:$TAG" -c \
  'touch /tmp/x && echo tmp=ESCRIBIBLE; touch /app/x 2>&1 && echo app=ESCRIBIBLE; grep -E "^CapBnd:" /proc/self/status' </dev/null 2>&1 || true)
echo "$CTRL" > "$OUT/30-negativas/control-sin-restricciones.txt"
rec N-08 "Control: misma imagen sin read_only ni cap_drop" "/tmp escribible y CapBnd ≠ 0 (la sonda detecta escritura)" \
  "$(echo "$CTRL" | tr '\n' ' ' | cut -c1-120)" "$(echo "$CTRL" | grep -q 'tmp=ESCRIBIBLE' && ! echo "$CTRL" | grep -q 'CapBnd:.0000000000000000' && echo 0 || echo 1)"

# Artefacto de la emulación local (no de Fargate): con raíz de solo lectura, la traducción amd64 de Docker Desktop
# (Rosetta) aborta algunos procesos auxiliares («Failed to create temporary file», código 133); los servicios no
# lo provocan. Se compara la misma base Alpine 3.24.4 en arm64 nativo y en amd64 emulado.
ALPINE_ARM64=alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
emu() { # plataforma imagen [--read-only]
  docker run --rm --pull never --platform "$1" ${3:-} --entrypoint sh "$2" -c \
    'sleep 3 & sleep 1; pidof sleep >/dev/null; echo "rc=$?"' </dev/null 2>&1 | tail -1
}
if docker image inspect --platform linux/arm64 "$ALPINE_ARM64" >/dev/null 2>&1; then
  a=$(emu linux/arm64 "$ALPINE_ARM64" --read-only)
  b=$(emu linux/amd64 "$PREFIX/db-ops:$TAG" --read-only)
  c=$(emu linux/amd64 "$PREFIX/db-ops:$TAG")
  printf 'arm64 nativo, solo lectura: %s\namd64 emulado, solo lectura: %s\namd64 emulado, escribible: %s\n' "$a" "$b" "$c" \
    > "$OUT/30-negativas/control-emulacion-rosetta.txt"
  rec X-01 "Control de emulación: pidof con raíz de solo lectura" "arm64 rc=0; amd64 ro rc=133; amd64 rw rc=0" "arm64 $a; amd64-ro $b; amd64-rw $c" \
    "$([ "$a" = rc=0 ] && [ "$b" = rc=133 ] && [ "$c" = rc=0 ] && echo 0 || echo 1)"
else
  echo "X-01 omitida: falta la imagen arm64 $ALPINE_ARM64" > "$OUT/30-negativas/control-emulacion-rosetta.txt"
fi
emul=$(for s in $SERVICES; do dc logs --no-color "$s" 2>&1; done | grep -c -i -e 'create_tempfile' -e 'breakpoint trap')
rec X-02 "Servicios sin abortos de la emulación en sus logs" 0 "$emul" "$([ "$emul" = 0 ] && echo 0 || echo 1)"

# ---------------------------------------------------------------------------------------- recuperación
echo "== Recuperación: PostgreSQL detenido y restaurado"
# Alcance (R-PR7A-06): estas pruebas solo demuestran el comportamiento de los PROCESOS y del healthcheck del
# CONTENEDOR (`/health`, mismos parámetros que el healthCheck de la task definition). No emulan el target group
# del ALB (`/health/ready`) ni el planificador de ECS, que en AWS puede detener y reemplazar tareas que el ALB
# marque como no sanas una vez pasado el período de gracia. Ese comportamiento queda pendiente de validar en AWS.
wait_codes() { # ruta esperado timeout → imprime segundos o -1
  local path=$1 want=$2 limit=$3 t0 all s
  t0=$(date +%s)
  while :; do
    all=1
    for s in $SERVICES; do [ "$(http_code "http://127.0.0.1:$(port_of "$s")$path")" = "$want" ] || all=0; done
    [ $all = 1 ] && { echo $(( $(date +%s) - t0 )); return 0; }
    [ $(( $(date +%s) - t0 )) -lt "$limit" ] || { echo -1; return 1; }
    sleep 2
  done
}
dc stop postgres > "$OUT/40-recuperacion/stop-postgres.log" 2>&1
secs=$(wait_codes /health/ready 503 60 || true)
rec R-01 "PostgreSQL detenido: /health/ready (readiness) de los 4 servicios" "503 en ≤ 60 s" "segundos=$secs" "$([ "$secs" != -1 ] && echo 0 || echo 1)"
for s in $SERVICES; do echo "$s ready=$(http_code "http://127.0.0.1:$(port_of "$s")/health/ready") live=$(http_code "http://127.0.0.1:$(port_of "$s")/health")"; done \
  > "$OUT/40-recuperacion/durante-caida.txt"
live_ok=$(grep -c 'live=200' "$OUT/40-recuperacion/durante-caida.txt" || true)
rec R-02 "PostgreSQL detenido: /health (ruta del healthCheck de contenedor)" "200 en los 4" "200=$live_ok/4" "$([ "$live_ok" = 4 ] && echo 0 || echo 1)"
sleep 65  # > interval × retries del healthcheck de contenedor (15 s × 3); no modela el ALB ni ECS
during=""; ok=0
for s in $SERVICES; do
  st=$(docker inspect --format '{{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}' "$(cid "$s")")
  during="$during $s:$st;"
  case "$st" in "running health=healthy restarts=0") ;; *) ok=1 ;; esac
done
echo "$during" | tr ';' '\n' > "$OUT/40-recuperacion/estado-tras-65s-de-caida.txt"
rec R-03 "65 s sin base de datos: procesos vivos y healthcheck de contenedor (Docker) sano" "running, healthy, 0 reinicios" "$(echo "$during" | cut -c1-230)" $ok

dc start postgres > "$OUT/40-recuperacion/start-postgres.log" 2>&1
secs=$(wait_codes /health/ready 200 120 || true)
rec R-04 "PostgreSQL restaurado: /health/ready de los 4 servicios" "200 en ≤ 120 s" "segundos=$secs" "$([ "$secs" != -1 ] && echo 0 || echo 1)"
if run_smoke "$OUT/40-recuperacion/smoke-tras-recuperacion.json"; then ok=0; else ok=1; fi
summary=$($CHECKS smoke-summary "$OUT/40-recuperacion/smoke-tras-recuperacion.json" || true)
rec R-05 "Smoke E2E tras la recuperación" "11/11 PASS" \
  "$(python3 -I -c 'import json,sys;d=json.loads(sys.argv[1]);print("{}/{} {}".format(d["steps_passed"], d["steps_total"], d["verdict"]))' "$summary" 2>/dev/null || echo error)" \
  "$(echo "$summary" | grep -q '"steps_passed": 11, ' && [ $ok = 0 ] && echo 0 || echo 1)"
ok=0; after=""
while read -r s rest; do
  now=$(docker inspect --format '{{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$(cid "$s")")
  after="$after$s $now
"
  [ "$now" = "$rest" ] || ok=1
done < "$STATE_BEFORE"
printf '%s' "$after" > "$OUT/40-recuperacion/estado-final.txt"
rec R-06 "Sin reinicios de contenedores Docker en toda la prueba" "mismo StartedAt y RestartCount=0" "$( [ $ok = 0 ] && echo sin-cambios || echo cambios)" $ok

# ----------------------------------------------------------------------------------- logs y permisos
for s in postgres kms $SERVICES $JOBS; do dc logs --no-color "$s" > "$OUT/50-logs/$s.log" 2>&1 || true; done
perm=$(cat "$OUT"/50-logs/{identity,catalog,commerce,audit}-service.log "$OUT"/50-logs/*-migrate.log \
  "$OUT"/50-logs/postgres-provision.log "$OUT"/50-logs/postgres-finalize.log |
  grep -E -i -c 'EACCES|EROFS|EPERM|read-only file system|permission denied|operation not permitted' || true)
grep -E -i -n 'EACCES|EROFS|EPERM|read-only file system|permission denied|operation not permitted' \
  "$OUT"/50-logs/*-service.log "$OUT"/50-logs/*-migrate.log "$OUT"/50-logs/postgres-*.log > "$OUT/50-logs/errores-permisos.txt" 2>&1 || true
rec P-09 "Logs de servicios y tareas sin errores de permisos" 0 "$perm" "$([ "$perm" = 0 ] && echo 0 || echo 1)"

# ------------------------------------------------------------------------------------------ cierre
dc stop > "$OUT/40-recuperacion/stop-final.log" 2>&1 || true
redaction=$($CHECKS redact "$ENVF" "$OUT") && ok=0 || ok=1
echo "$redaction" > "$OUT/redaccion.json"
rec E-01 "Evidencias sin valores secretos" "0 archivos con secretos" "$redaction" $ok
(cd "$OUT" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS)
echo
echo "Resultados: $RESULTS (fallos: $FAILS). Proyecto $P detenido; contenedores y volúmenes conservados."
[ "$FAILS" = 0 ]
