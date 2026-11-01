# Third-party software and trademarks

## This repository

bambu-harness itself is MIT-licensed (see `LICENSE`). It has no runtime npm dependencies.

## OrcaSlicer (downloaded, not bundled)

`scripts/install-orcaslicer.sh` downloads [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) 2.4.2 as a Linux AppImage from the upstream GitHub release and verifies a pinned SHA-256 digest before use.

OrcaSlicer is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. This repository does **not** ship OrcaSlicer source or binaries. If you run the installer, you are obtaining OrcaSlicer from its upstream project under that project's license terms. Review [OrcaSlicer's LICENSE](https://github.com/OrcaSlicer/OrcaSlicer/blob/main/LICENSE.txt) before distributing a modified slicer or combining it with other code in ways that would trigger AGPL obligations.

The AppImage and its extracted `squashfs-root/` tree are gitignored and must not be committed.

## Official machine / process / filament profiles

`bambu slice` loads and flattens three profiles from inside the installed OrcaSlicer AppImage (paths relative to the AppImage `resources/` tree):

- `profiles/BBL/machine/Bambu Lab A1 mini 0.4 nozzle.json`
- `profiles/BBL/process/0.20mm Standard @BBL A1M.json`
- `profiles/BBL/filament/Bambu PLA Basic @BBL A1M.json`

Those JSON files are **not** copied into this repository. They remain part of the OrcaSlicer / Bambu Lab profile set distributed with OrcaSlicer. Attribution for those profiles belongs to their upstream authors (Bambu Lab / OrcaSlicer contributors) under the terms shipped with that release. Do not paste proprietary Studio profile packs into this tree without a clear license.

## Protocol documentation consulted

Public research and docs used as references (not vendored as code) are listed in `PROTOCOL_NOTES.md`, including OpenBambuAPI LAN MQTT/FTPS notes and Bambu Lab wiki pages. Review those projects' licenses before copying their code.

## Trademarks

Bambu Lab, Bambu Handy, Bambu Studio, A1 mini, and related names are trademarks of their respective owners. OrcaSlicer is a trademark of its owners. This project is unofficial and unaffiliated; use of those names is descriptive only.
