#!/bin/sh
# Evidence capture only; checker return codes are recorded, not treated as semantic classifications.
set -u
if [ "$#" -lt 1 ]; then echo "usage: $0 OUTPUT_DIRECTORY" >&2; exit 2; fi
OUT=$1
mkdir -p "$OUT/spec"
OUT=$(CDPATH= cd "$OUT" && pwd)
ROOT=$(CDPATH= cd "$(dirname "$0")/../../../.." && pwd)
SPIKE=$ROOT/docs/plans/formal-verification/spike
JAVA_HOME=${DT_FV_JAVA_HOME:-"$HOME/.local/share/mise/installs/java/temurin-27.0.1.1+4"}
JAVA="$JAVA_HOME/bin/java"
TLC174=${DT_FV_TLC174:-"$HOME/.cache/domaintrail-fv/tools/tla-1.7.4/tla2tools.jar"}
TLC180=${DT_FV_TLC180:-"$HOME/.cache/domaintrail-fv/tools/tla-1.8.0/tla2tools.jar"}
APALACHE_TGZ=${DT_FV_APALACHE_TGZ:-"$HOME/.cache/domaintrail-fv/tools/apalache-0.63.0/apalache-0.63.0.tgz"}
APALACHE=${DT_FV_APALACHE_HOME:-"$HOME/.cache/domaintrail-fv/tools/apalache-0.63.0/apalache-0.63.0/bin/apalache-mc"}
check_hash() {
 file=$1 expected=$2 label=$3
 actual=$(shasum -a 256 "$file" | awk '{print $1}')
 if [ "$actual" != "$expected" ]; then echo "SHA-256 mismatch for $label: expected $expected, got $actual" >&2; exit 1; fi
}
check_hash "$TLC174" 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 'TLC 1.7.4 jar'
check_hash "$TLC180" 67f9575c3b9ef7a0787b1bded34812862ffe79d711298e5a75b1a77720b19928 'TLC 1.8.0 jar'
check_hash "$APALACHE_TGZ" a756e96af249bf33cd7629667a49472cb26ac8227c48583da139b414834d59df 'Apalache 0.63.0 tarball'
# Apalache 0.63.0 tree has one jar: lib/apalache.jar; pin it too.
APALACHE_JAR=$(dirname "$APALACHE")/../lib/apalache.jar
check_hash "$APALACHE_JAR" f2d43f2e279a657be50b2ecec3a013ba2915266008a2562b38412c3269347dc9 'Apalache jar'
cp "$SPIKE/Order.tla" "$SPIKE"/*.cfg "$OUT/spec/"
cd "$OUT/spec" || exit 1
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"; export PATH
run() {
 label=$1 logfile=$2; shift 2
 printf '\n========== %s ==========\n' "$label"; printf 'COMMAND: %s\n' "$*"
 (/usr/bin/time -p "$@") >"$OUT/$logfile" 2>&1; rc=$?; cat "$OUT/$logfile"
 printf 'EXIT CODE: %s\n' "$rc"
 real=$(awk '$1 == "real" { print $2; exit }' "$OUT/$logfile")
 printf 'WALL TIME: %ss (real from /usr/bin/time -p)\n' "${real:-unavailable}"
}
run 'JVM startup only' java-version.log "$JAVA" -version
run 'SANY Order' sany-Order.log "$JAVA" -cp "$TLC174" tla2sany.SANY Order.tla
if grep -Eq 'Semantic errors|Parsing error|\*\*\* Errors' "$OUT/sany-Order.log"; then echo 'SANY FAILED: Order (see sany-Order.log)'; fi
for cfg in *.cfg; do
 label=${cfg%.cfg}
 run "TLC $label" "tlc-$label.log" "$JAVA" -cp "$TLC174" tlc2.TLC -metadir "$OUT/meta-$label" -config "$cfg" Order.tla
done
run 'TLC 1.8.0 JSON missing_requires_confirm__C_probes' tlc180-missing_requires_confirm-C_probes.log "$JAVA" -cp "$TLC180" tlc2.TLC -dumpTrace json "$OUT/missing_requires_confirm-C_probes-trace.json" -metadir "$OUT/meta-tlc180-confirm" -config missing_requires_confirm__C_probes.cfg Order.tla
run 'TLC 1.8.0 JSON none__only_Cancel' tlc180-none-only_Cancel.log "$JAVA" -cp "$TLC180" tlc2.TLC -dumpTrace json "$OUT/none-only_Cancel-trace.json" -metadir "$OUT/meta-tlc180-cancel" -config none__only_Cancel.cfg Order.tla
run 'Apalache bounded none' apalache-none.log "$APALACHE" check --out-dir="$OUT/apalache-none" --config=none__C_all.cfg --length=4 --inv=Inv Order.tla
run 'Apalache bounded missing_requires_confirm' apalache-missing_requires_confirm.log "$APALACHE" check --out-dir="$OUT/apalache-missing_requires_confirm" --config=missing_requires_confirm__only_Confirm.cfg --length=4 --inv=Inv Order.tla
