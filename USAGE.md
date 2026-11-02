# Usage

LAN-only control of one Bambu Lab A1 mini. Enable **LAN Only Mode** and **Developer Mode** on the printer first.

## Configure

```bash
install -m 0700 -d ~/.bambu-harness
install -m 0600 /dev/null ~/.bambu-harness/access-code
# put the printer access code on one line in that file

node src/cli.js lan configure --host <printer-ip> --serial <SERIAL>
```

Use `--access-code-file ~/.bambu-harness/access-code` on later commands. `BAMBU_ACCESS_CODE` works but is visible in `/proc`.

## Everyday commands

```bash
node src/cli.js lan status --access-code-file FILE
node src/cli.js lan ls --access-code-file FILE
node src/cli.js lan get "name with spaces.gcode.3mf" --out ./copy.gcode.3mf --access-code-file FILE
node src/cli.js lan get big.gcode.3mf --out ./big.gcode.3mf --timeout-sec 900 --access-code-file FILE
```

`lan ls` `modified` stamps are the printer's own local clock (no timezone on the FTPS LIST wire). They are printed as `YYYY-MM-DDTHH:MM:SS` without a `Z` / offset, and the JSON includes `modifiedClock: "printer-local"`.

FTPS data transfers (`lan get`, `lan upload`, and the upload step of `lan print`) idle-timeout after 20 seconds with no chunk, and cap overall duration with `--timeout-sec` (default 600, max 7200). That is separate from `--timeout` (MQTT waits).

```bash
node src/cli.js lan snapshot --out frame.jpg --access-code-file FILE
node src/cli.js lan upload model.gcode.3mf --access-code-file FILE
node src/cli.js lan upload model.gcode.3mf --timeout-sec 900 --access-code-file FILE
node src/cli.js lan print model.gcode.3mf --yes --access-code-file FILE
node src/cli.js lan stop --yes --access-code-file FILE
node src/cli.js lan diagnose --access-code-file FILE
```

If `lan print` reports an MQTT puback timeout, run `lan status` before retrying — the job may already be running.

`lan print` refuses a sliced first-layer bed below about 50°C unless `--force`. A missing or unreadable bed temperature is treated as unknown and is also refused unless `--force`.

`lan print` runs preflight/bed-bounds before upload (all XY travels after start G-code must stay in 0..180 on an A1 mini). Check a file without printing:

```bash
node src/cli.js check-bounds model.gcode.3mf
```

Override only with `--skip-bounds-check=I_UNDERSTAND_BED_CRASH_RISK`.

`lan watch-first-layer --auto-stop` requires `--yes` (it can stop a print).

## Making plates safely

```bash
node src/cli.js plate info source.gcode.3mf
node src/cli.js plate build source.gcode.3mf --objects 278,318 --copies 4 --gap 4 --margin 5 \
  --filament-type PLA --nozzle-temp 215 --nozzle-temp-first-layer 220 --bed-temp 60 --fan 100 \
  --out plate.gcode.3mf
node src/cli.js check-bounds plate.gcode.3mf   # exit 4 + ok:false if refused
```

The plate builder is Node (same as the rest of this repo). It strips each copy’s pre-extrusion travel-in waypoint and travels to the **start** of the first extruding move (critical for G2/G3 arcs), shelf-packs part bboxes with gap≥4 and margin≥5 (`--layout center` by default, `--layout front` to pin the pack to the front margin), rewrites **actual** `M104`/`M109`/`M140`/`M190`/`M106` commands (not just comments), rewrites filament header fields (type, nozzle range, nozzle/bed/plate temperatures) to the target filament, writes a `first_layer_bed_temperature` note into `slice_info.config`, sets PLA `tray_info_idx` to `GFA00` and colour to `#FFFFFF` unless `--colour` is set, recomputes time/weight metadata for N copies, emits distinct `M624`/`M625` labels per tiled copy, updates bed levelling bounds, and refuses to write a plate that fails preflight. Stock start `M211 X0 Y0 Z0` disables firmware limits — preflight is the bed-crash guard after that. Preflight hard-fails when print-phase nozzle commands disagree with `; nozzle_temperature` / first-layer settings or the filament range. A header nozzle range that sits outside the declared filament’s built-in band (PLA 190–240, PETG 230–270, PLA-silk 190–240, ABS 240–280, TPU 200–250) is ignored in favor of that band. `--nozzle-range-low` and `--nozzle-range-high` override the written window.

## Slice

```bash
bash scripts/install-orcaslicer.sh
node src/cli.js slice model.stl --layer 0.2 --infill 15 --supports --filament PLA --out model.gcode.3mf
```

Print the resulting `.gcode.3mf`. Plate type and bed temperature must match the physical plate.

## Actuators

Require `--yes`. Nozzle ≤ 260°C, bed ≤ 80°C, part fan only (PWM 0–255).

```bash
node src/cli.js lan calibrate bed-level --yes --access-code-file FILE
node src/cli.js lan temperature nozzle 210 --yes --access-code-file FILE
node src/cli.js lan temperature bed 60 --yes --access-code-file FILE
node src/cli.js lan fan part 128 --yes --access-code-file FILE
node src/cli.js lan speed standard --yes --access-code-file FILE
```

## Certificate pinning

First connect pins the printer certificate into `lan-pins.json`. A later mismatch exits with `cert_changed` before the access code is sent. Pass `--accept-new-pin` only after you have checked the device at `<printer-ip>`.
