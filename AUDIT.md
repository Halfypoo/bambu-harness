# Audit notes

This project is intentionally **LAN-only**. It does not implement Bambu cloud login, cloud MQTT, or cloud upload.

When reviewing third-party references:

- Prefer OpenBambuAPI MQTT/FTPS/camera docs over cloud HTTP bridges.
- Do not copy application private keys, signing code, or telemetry hosts.
- Do not add argv flags for access codes or passwords.
- Keep host allowlisting (single RFC1918 address) and certificate pinning.

Hardware claims in docs should distinguish a one-printer observation from a guarantee. Mark unverified actuators as `UNVERIFIED`.
