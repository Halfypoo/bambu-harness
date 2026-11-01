# Protocol notes (LAN)

Sources used for shapes (not vendored as code): [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) `mqtt.md` / `ftp.md` / camera notes, community FTPS session-reuse notes, and Bambu Lab public wiki pages on third-party / developer mode. This harness does not call Bambu cloud HTTP or cloud MQTT.

## Local MQTT (TLS port 8883)

Username `bblp`, password the printer access code. Topics:

- subscribe `device/<SERIAL>/report`
- publish `device/<SERIAL>/request`

Common payloads:

- `pushing.pushall` — request a status dump
- `info.get_version` — firmware modules
- `print.command` `pause` / `resume` / `stop`
- `print.command` `project_file` after FTPS upload, with `url` like `ftp:///<basename>`
- `print.gcode_line` for temperature / fan lines
- `print.print_speed`, `print.calibration`

Status fields commonly read from `push_status`: `gcode_state`, `mc_percent`, `layer_num`, `total_layer_num`, nozzle/bed temps and targets, `mc_remaining_time`, `print_error`, `hms`, `lights_report`, `wifi_signal`.

QoS 1 publishes wait for MQTT puback. A puback timeout does **not** prove the printer ignored the command; `lan print` may still have started. Check status before retrying.

## FTPS (implicit TLS port 990)

User `bblp`, password the access code. Typical sequence: `USER` / `PASS` / `PBSZ 0` / `PROT P` / `TYPE I` / `PASV` / data channel / `STOR` or `LIST` / `RETR`.

The passive address must match the configured printer host. The data channel often requires TLS session reuse (`require_ssl_reuse`); this client offers the control-connection TLS session to the data connection. Paths with spaces are sent quoted.

`LIST` / `MLSD` modification times are the printer's local clock with no timezone on the wire. `lan ls` keeps them as zoneless `YYYY-MM-DDTHH:MM:SS` strings and sets `modifiedClock` to `printer-local` — do not treat a trailing `Z` as UTC.

## Camera (TLS port 6000)

After TLS, an 80-byte auth packet: length `0x40`, type `0x3000`, NUL-padded user `bblp` and access code. Frames are a 16-byte header plus JPEG (`FF D8`…).

## Local `project_file`

After `STOR` of a `.gcode.3mf`, publish `print.project_file` with `param` = `Metadata/plate_N.gcode`, `url` = `ftp:///<file>`, `use_ams` false, and `bed_type` forced to `auto` for the local path. Plate type and bed temperature still come from the sliced project; they must match the physical plate.
