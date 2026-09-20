#!/usr/bin/env bash
#
# Aplica las migraciones en un Postgres de usar y tirar y ejercita todo lo que
# vive en la base: las funciones OAuth del conector y el decisor. No toca
# Supabase ni ninguna base real: crea un cluster en un directorio temporal, lo
# usa y lo borra.
#
#   scripts/verificar-esquema.sh
#
# Hace falta un Postgres 17 instalado. Si no esta en el PATH, se le pasa el
# directorio de binarios:
#
#   PG_BIN=/opt/homebrew/opt/postgresql@17/bin scripts/verificar-esquema.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  if command -v initdb >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v initdb)")"
  elif [ -d /opt/homebrew/opt/postgresql@17/bin ]; then PG_BIN=/opt/homebrew/opt/postgresql@17/bin
  else echo "No encuentro initdb. Pasa PG_BIN con el directorio de binarios de Postgres." >&2; exit 1
  fi
fi

# Postgres no admite rutas de socket largas, asi que el socket va en /tmp
# aunque el cluster no. Y el locale C, porque el postmaster no arranca si la
# variable de entorno no le vale.
export LC_ALL=C LANG=C
PUERTO="${PUERTO:-55432}"
DATOS="$(mktemp -d "${TMPDIR:-/tmp}/arboria-pg.XXXXXX")"

limpiar() {
  "$PG_BIN/pg_ctl" -D "$DATOS" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$DATOS"
}
trap limpiar EXIT

"$PG_BIN/initdb" -D "$DATOS" -U postgres --auth=trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATOS" -o "-k /tmp -h '' -p $PUERTO" -l "$DATOS/log" start >/dev/null
sleep 1

psql() { "$PG_BIN/psql" -h /tmp -p "$PUERTO" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql -f "$RAIZ/scripts/sql/00-supabase-simulado.sql"
for migracion in "$RAIZ"/supabase/migrations/*.sql; do
  psql -f "$migracion"
done
# Cada fichero de pruebas corre en su propia sesion, asi que lo temporal de uno
# no llega al siguiente. Es a proposito: cada uno se basta solo.
for pruebas in "$RAIZ"/scripts/sql/0[1-9]-pruebas-*.sql; do
  echo
  echo "== $(basename "$pruebas")"
  psql -f "$pruebas"
done
