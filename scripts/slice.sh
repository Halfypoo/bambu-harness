#!/usr/bin/env bash
# Slice an STL or 3MF for a Bambu Lab A1 mini (0.4 mm nozzle, PLA).
# Installs nothing. scripts/install-orcaslicer.sh fetches OrcaSlicer 2.4.2.
#
#   scripts/slice.sh model.stl [output.gcode.3mf]
#   scripts/slice.sh --print-plan model.stl [output.gcode.3mf]
#   scripts/slice.sh --install
#
# Extra slicer flags are not passed through. Use:
#   node src/cli.js slice model.stl --layer 0.2 --infill 15 --supports --filament PLA --out out.gcode.3mf
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,12p' "$0"
  exit 0
fi
if [[ "${1:-}" == "--install" ]]; then
  exec "$ROOT/scripts/install-orcaslicer.sh"
fi

print_plan=0
if [[ "${1:-}" == "--print-plan" ]]; then
  print_plan=1
  shift
fi

model="${1:-}"
out="${2:-}"
if [[ -z "$model" ]]; then
  echo "usage: scripts/slice.sh [--print-plan] model.stl|model.3mf [output.gcode.3mf]" >&2
  exit 4
fi

args=(slice "$model")
if [[ -n "$out" ]]; then
  args+=(--out "$out")
fi
if [[ "$print_plan" == 1 ]]; then
  args+=(--print-plan)
fi
exec node "$ROOT/src/cli.js" "${args[@]}"
