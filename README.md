# bambu-harness

Zero-dependency **Node.js 22+** CLI to drive a **Bambu Lab A1 mini** over the local network. Slice with OrcaSlicer, then upload and print with LAN Only Mode + Developer Mode.

Stdout is JSON. Errors are JSON on stderr. Access codes are never printed.

This project is **unofficial** and **not affiliated with, endorsed by, or supported by Bambu Lab**. Use at your own risk. See `LICENSE` (MIT) and `THIRD_PARTY.md`.

## Requirements

- Node.js 22 or newer
- A machine that can reach the printer on the LAN (ports **8883** MQTT, **6000** camera, **990** FTPS + the printer’s FTPS passive data ports)
- A Bambu Lab A1 mini with **LAN Only Mode** and **Developer Mode** enabled
- Optional: OrcaSlicer (for `bambu slice`) via `scripts/install-orcaslicer.sh`

## Enable LAN Only Mode and Developer Mode

On the printer screen:

1. Connect the printer to your Wi‑Fi (or Ethernet if available).
2. Enable **LAN Only Mode**.
3. Enable **Developer Mode**.

While those modes are on, cloud printing and Bambu Handy control for that printer are off. This harness only uses the LAN route.

## Why LAN only

The harness talks to the printer over the local network only, because Bambu's cloud route was not usable for this.

## Access code and serial

On the printer screen (LAN / network / developer settings), note:

- **IP address** — use a private IPv4 address such as `<printer-ip>`
- **Access code** — 8–16 letters or digits (LAN password)
- **Serial number** — printed on the device / shown in settings as `<SERIAL>`

Store the access code in a mode `0600` file. Prefer that over `BAMBU_ACCESS_CODE` (environment variables are visible in `/proc`).

```bash
install -m 0700 -d ~/.bambu-harness
install -m 0600 /dev/null ~/.bambu-harness/access-code
# write the access code yourself into that file (one line, no quotes)
```

Never put the access code on the command line (`--access-code` is refused). Never commit it.

## Install and run

```bash
git clone https://github.com/Halfypoo/bambu-harness.git
cd bambu-harness
npm test
node --check src/cli.js
node src/cli.js --help
```

Optional: `npm link` to put `bambu` on your `PATH`.

Configure the printer once:

```bash
node src/cli.js lan configure --host <printer-ip> --serial <SERIAL>
```

`lan configure` writes only host + serial to `~/.bambu-harness/lan.json` (mode `0600`). The access code is never stored there.

## Command reference

Replace `FILE` with your access-code path (for example `~/.bambu-harness/access-code`).

```bash
# Status and storage
node src/cli.js lan status --access-code-file FILE
node src/cli.js lan ls --access-code-file FILE
node src/cli.js lan ls / --access-code-file FILE
node src/cli.js lan get "my model.gcode.3mf" --out ./local.gcode.3mf --access-code-file FILE
node src/cli.js lan get big.gcode.3mf --out ./big.gcode.3mf --timeout-sec 900 --access-code-file FILE
# lan ls modified times are printer-local (no Z / offset); see USAGE.md

# Camera
node src/cli.js lan snapshot --out frame.jpg --access-code-file FILE

# Upload / print / stop
node src/cli.js lan upload job.gcode.3mf --access-code-file FILE
node src/cli.js lan upload job.gcode.3mf --timeout-sec 900 --access-code-file FILE
node src/cli.js lan print job.gcode.3mf --yes --access-code-file FILE
node src/cli.js lan print job.gcode.3mf --yes --force --access-code-file FILE
node src/cli.js lan stop --yes --access-code-file FILE

# Read-only diagnose and actuators (actuators need --yes)
node src/cli.js lan diagnose --access-code-file FILE
node src/cli.js lan calibrate bed-level --yes --access-code-file FILE
node src/cli.js lan temperature nozzle 210 --yes --access-code-file FILE
node src/cli.js lan temperature bed 60 --yes --access-code-file FILE
node src/cli.js lan fan part 128 --yes --access-code-file FILE
node src/cli.js lan speed standard --yes --access-code-file FILE

# Optional first-layer camera watch (--auto-stop also needs --yes)
node src/cli.js lan watch-first-layer --out ./first-layer --every 10 --minutes 3 --access-code-file FILE
node src/cli.js lan watch-first-layer --out ./first-layer --every 10 --minutes 3 --auto-stop --yes --access-code-file FILE
```

Remote FTPS names may contain spaces — quote them in the shell.

FTPS `lan get` / `lan upload` / `lan print` (upload phase) use an **idle** data timeout (20s with no received/sent chunk) plus an overall transfer ceiling (**600s** by default, override with `--timeout-sec`, max 7200). Slow-but-steady transfers keep going; a stalled transfer fails with `FTPS data timed out`. `--timeout` is separate and only covers MQTT command / print-ack waits (1–120s).

`lan print` refuses a sliced first-layer bed target below about **50°C** (typical PLA on a warm plate) unless you pass `--force`. A missing or unreadable bed temperature is treated as **unknown** and is also refused unless you pass `--force`. Confirm plate type and bed temperature match the physical plate.

`lan print` also runs a **bed-bounds / preflight** check before upload. After the start G-code, every `G0`/`G1`/`G2`/`G3` move (travels included) must stay inside the A1 mini bed (0..180 mm). Stock start/end wipe and mid-print timelapse/`SKIPPABLE` parks are whitelisted. Override only with `--skip-bounds-check=I_UNDERSTAND_BED_CRASH_RISK`.

### Making plates safely

Do **not** hand-shift copied toolpaths with ad-hoc scripts that offset every `X`/`Y`, including each part’s pre-extrusion “travel in” waypoint. That is how a 4-pair plate produced Y≈213 mm travels (bed is 180 mm) while `M211` had software limits off — the bed slammed its stop at full speed.

Stock A1 mini start G-code runs `M211 X0 Y0 Z0` (firmware soft endstops OFF). After start, **this harness bed-bounds check is the only guard**. Preflight hard-refuses any non-stock `M211` or any `M211` after the start section.

Use the in-repo plate builder (Node, zero extra deps — same language as the harness):

```bash
# List object ids / names / bboxes in a sliced plate
node src/cli.js plate info source.gcode.3mf

# Build N copies of selected objects (shelf-packs by bounding box; gap≥4, margin≥5)
node src/cli.js plate build source.gcode.3mf --objects 278,318 --copies 4 --gap 4 --margin 5 \
  --filament-type PLA --nozzle-temp 215 --nozzle-temp-first-layer 220 --bed-temp 60 --fan 100 \
  --out plate.gcode.3mf
node src/cli.js check-bounds plate.gcode.3mf
node src/cli.js lan print plate.gcode.3mf --yes --access-code-file FILE
```

Example for a Gyro2 tread slice (cones A/B are typically ids **278** and **318**):

```bash
node src/cli.js plate info gyro2-tread.3mf
node src/cli.js plate build gyro2-tread.3mf --objects 278,318 --copies 4 --gap 4 --margin 5 \
  --filament-type PLA --nozzle-temp 215 --nozzle-temp-first-layer 220 --bed-temp 60 --fan 100 \
  --out spiral-pairs-x4.gcode.3mf
node src/cli.js check-bounds spiral-pairs-x4.gcode.3mf
```

Rules:

- Every plate must pass `check-bounds` / preflight before printing (also enforced by `lan print`). Exit code **4** and JSON `ok: false` on refusal.
- Gaps between parts ≥ 4 mm; bed margin ≥ 5 mm. Layout uses shelf/bin packing of each part’s bounding box (not a uniform max-cell grid) so 4 A+B pairs can fit when geometrically possible; otherwise it reports exactly how much X/Y is missing. `--layout center` (the default) centres a 2-pair plate on the bed; `--layout front` keeps the pack against the front margin. A plate-json bbox that disagrees with the extruded area (skirt, brim, prime line) is a warning. Extrusion outside the bed, and a per-object bbox outside the bed, stay hard errors.
- `--objects id,id` selects which source parts to tile (default: all). Use `plate info` to list ids.
- The builder drops each copy’s lead-in travel waypoints and inserts one clean move to the **start** of the first extruding move (so G2/G3 I/J arcs keep their geometry), limits `G29` to the occupied area, and refuses to write a file that fails preflight. It does **not** silently clamp travels — the validator decides.
- Filament retarget rewrites real G-code commands (not just comments): `--filament-type`, `--nozzle-temp`, `--nozzle-temp-first-layer`, `--bed-temp`, `--fan` (0–100%), `--bridge-fan`. It also rewrites filament header fields (`filament_type`, nozzle range low/high, nozzle and bed/plate temperatures, volumetric speed) to the target filament. Defaults are PLA 190–240°C, PLA-silk 190–240°C, PETG 230–270°C, ABS 240–280°C, TPU 200–250°C, overridable with `--nozzle-range-low` / `--nozzle-range-high`. Preflight uses that built-in band when the header range sits outside it, and hard-fails nozzle command vs settings/range mismatches.

### `lan print` and MQTT puback timeouts

After upload, `lan print` sends a local MQTT `project_file` command. The printer may start the job even if the MQTT **puback** times out. When that happens the CLI reports it clearly (and may confirm via `lan status`). **Do not retry** the same start until you have checked status — use `lan status` first. Successful print responses include `doNotRetry: true` for the same reason.

## Certificate pinning

The printer’s TLS certificates are self-signed. On first successful connect the harness stores `sha256(cert.raw)` in `~/.bambu-harness/lan-pins.json` (mode `0600`), keyed by `ip:port`. The access code is sent only after that pin is stored.

If the certificate later changes, the command exits before sending the access code (`cert_changed`). Confirm you are talking to your printer, then re-run once with `--accept-new-pin`.

## Slicing notes

The A1 mini needs a **sliced** `.gcode.3mf` project file (not a raw STL) to print.

```bash
sudo apt-get install -y libopengl0 libglu1-mesa libegl1 libwebkit2gtk-4.1-0 xvfb ca-certificates curl
bash scripts/install-orcaslicer.sh
node src/cli.js slice model.stl --layer 0.2 --infill 15 --filament PLA --out model.gcode.3mf
```

- Target the **A1 mini / 0.4 mm** profile.
- **Plate type** in the slice must match the plate on the printer (Cool Plate, Textured PEI, etc.).
- **Bed temperature** must match that plate and filament. Cool-plate PLA is often below 50°C; `lan print` will refuse those jobs unless you pass `--force`. Missing bed temperature is refused the same way.
- OrcaSlicer is downloaded, not bundled (AGPL — see `THIRD_PARTY.md`).

## Safety notes

- Stay where you can see the printer for the first live jobs.
- Destructive or motion commands require `--yes` (`lan print`, `lan stop`, temperature, fan, speed, calibrate actuators, and `lan watch-first-layer --auto-stop`).
- Prefer `lan status` / `lan diagnose` before retrying a print.
- Cap (client-side): nozzle ≤ 260°C, bed ≤ 80°C, part fan PWM 0–255.
- Print file must be `.gcode.3mf` with `Metadata/plate_N.gcode`, ≤ 100 MiB.
- Every plate must pass the bed-bounds check (travels included) before printing; see **Making plates safely**.
- LAN host must be one RFC1918 address in `lan.json`. There is no discovery or scan.
- Do not set `BAMBU_HARNESS_TEST` on a machine that talks to a real printer.
- Override the config directory only with an absolute `BAMBU_HARNESS_HOME`.

## Layout

`~/.bambu-harness/` mode `0700`. `lan.json` and `lan-pins.json` mode `0600`. Access code file mode `0600`.

Exit codes: `0` ok, `1` failure, `3` not acknowledged / rejected / puback timeout, `4` bad arguments or bad file.

More detail: `USAGE.md`, `SECURITY.md`, `PROTOCOL_NOTES.md`, `CONTRIBUTING.md`.
