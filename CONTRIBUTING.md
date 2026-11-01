# Contributing

Thanks for looking at bambu-harness. Keep changes small, auditable, and honest about what was verified on hardware.

## Before you open a PR

1. Use Node.js 22 or newer.
2. Run `node --check src/cli.js` and `npm test`.
3. Do not add runtime npm dependencies unless there is a strong reason, and then pin them and run `npm audit`.
4. Do not put secrets, access codes, real serials, personal emails, or home IPs in commits, fixtures, logs, or docs. Use placeholders such as `<SERIAL>`, `<printer-ip>`, and `you@example.com`. The keys and certificates under `test/fixtures/certs/` are synthetic test fixtures only.
5. Prefer `--access-code-file` over env. Reject new flags that put passwords or codes on the command line.
6. Mark anything not run on a real A1 mini as `UNVERIFIED` in JSON and docs when claiming hardware behaviour.

## Scope

- This tool targets the Bambu Lab A1 mini (model code `N1`), 0.4 mm nozzle, PLA defaults.
- LAN only: one RFC1918 address, no cloud login, no discovery.
- The slicer is downloaded by `scripts/install-orcaslicer.sh`. Do not vendor OrcaSlicer or Bambu Studio binaries into the repo.
- No telemetry. No install/postinstall scripts that phone home.

## Docs

Update `README.md` when the operator path changes. Update `SECURITY.md` when hosts or secret handling change. Update `PROTOCOL_NOTES.md` when MQTT/FTPS shapes change, with a source link.

## License

By contributing, you agree your contributions are licensed under the MIT License (see `LICENSE`).
