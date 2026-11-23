#!/bin/sh
# Verificacion local del proyecto Node.js.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -f package.json ]; then
  echo "SIN_SUITE: todavia no hay package.json (tarea de estructura pendiente)."
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install --no-audit --no-fund
fi

if ! grep -q '"test"' package.json; then
  echo "SIN_SUITE: package.json todavia no declara el script de pruebas."
  exit 0
fi

echo "Corriendo pruebas..."
# La salida se captura para poder distinguir "todo paso" de "no corrio nada".
# Una suite vacia es un fallo: el gate exige al menos una prueba en verde.
SALIDA="$(npm test --silent 2>&1)" || {
  echo "$SALIDA"
  echo "ERROR: las pruebas fallaron." >&2
  exit 1
}
echo "$SALIDA"

# Node 24 reporta el resumen con dos formatos: '# pass N' en el reporter TAP
# y 'ℹ pass N' en el reporter por defecto. Se acepta cualquiera de los dos.
# El caracter 'ℹ' es multibyte: bajo un locale C.UTF-8 el rango [^[:alpha:]] deja
# de cubrirlo y la linea no coincide. Se fija LC_ALL=C solo para estas dos
# lecturas, que trabajan sobre bytes ASCII y numeros.
PASARON="$(printf '%s\n' "$SALIDA" | LC_ALL=C grep -E '^[^0-9]*pass [0-9]+' | tail -1 | LC_ALL=C grep -oE '[0-9]+' | head -1)"
FALLARON="$(printf '%s\n' "$SALIDA" | LC_ALL=C grep -E '^[^0-9]*fail [0-9]+' | tail -1 | LC_ALL=C grep -oE '[0-9]+' | head -1)"

if [ -z "$PASARON" ]; then
  echo "ERROR: no se pudo leer el resumen de las pruebas." >&2
  exit 1
fi
if [ "$PASARON" = "0" ]; then
  echo "ERROR: la suite corrio cero pruebas." >&2
  exit 1
fi
if [ -n "$FALLARON" ] && [ "$FALLARON" != "0" ]; then
  echo "ERROR: hubo $FALLARON prueba(s) fallida(s)." >&2
  exit 1
fi

echo "VERIFICACION: ok ($PASARON prueba(s) en verde)"
