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

`lan watch-first-layer --auto-stop` requires `--yes` (it can stop a print).

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
