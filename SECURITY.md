# Security

## Reporting

If you find a vulnerability in this repository, open a private report to the maintainer (GitHub Security Advisory if enabled, otherwise contact the repo owner). Do not file a public issue that includes access codes or personal printer details.

## What is stored

`~/.bambu-harness/` (or `$BAMBU_HARNESS_HOME/`):

| File | Contents | Mode |
| --- | --- | --- |
| (directory) | config root | `0700` |
| `lan.json` | printer host + serial only | `0600` |
| `lan-pins.json` | TLS certificate fingerprints by `ip:port` | `0600` |

The LAN access code is **not** stored in `lan.json`. Keep it in a separate regular file mode `0600` and pass `--access-code-file`. Symlinks at the config paths are refused. The home directory, `/`, `/tmp`, and the temp root are refused as the config directory.

## Credentials

- Access codes are never accepted as `--access-code` (or similar) on the command line.
- Prefer `--access-code-file` (mode `0600`, one line, 8–16 letters or digits).
- `BAMBU_ACCESS_CODE` is accepted but is visible to the same user in `/proc/<pid>/environ`.
- Credentials are noted for redaction and stripped from error text. They are never logged intentionally.

## Network

LAN commands talk only to the single RFC1918 IPv4 address in `lan.json` (`10/8`, `172.16/12`, `192.168/16`). Names, public addresses, link-local, and loopback are refused outside the test harness. There is no discovery or mDNS scan.

Production ports: MQTT `8883`, camera `6000`, FTPS `990`. FTPS `PASV` must return that same configured host; any other passive address is refused.

There is no cloud API, cloud MQTT, or cloud upload path in this project.

## Certificate pinning

LAN camera, LAN MQTT, and FTPS set `rejectUnauthorized` to false only inside `src/lan-tls.js` and the LAN branch of `src/mqtt.js`, and only after the host allowlist has accepted the address.

On the first successful handshake the harness stores `sha256(cert.raw)` in `lan-pins.json`. The access code is sent only after that pin is stored. A later fingerprint change closes the socket before the access code is written (`cert_changed`). `--accept-new-pin` replaces the pin after you have checked the printer.

Trust on first use cannot detect an attacker already on the path during the first connection. Pin the printer on a network you trust.

## Slicer binary

OrcaSlicer is a third-party AppImage, not an npm dependency. `scripts/install-orcaslicer.sh` downloads one pinned URL and checks a digest. It refuses to run as root. The process is not given the access code or a shell. Review the pin before running the installer. See `THIRD_PARTY.md`.

## Redaction

Errors pass through a redactor for the current access code, `Bearer` values, JWT-shaped strings, and other noted secrets.

## Test switch

`BAMBU_HARNESS_TEST=1` limits LAN commands to `127.0.0.1` and the ports in `BAMBU_LAN_CAMERA_PORT`, `BAMBU_LAN_MQTT_PORT`, and `BAMBU_LAN_FTPS_PORT`. Do not set the test variable on a machine that talks to a printer.
