# door terminal contract v1

The wire contract the ESP32 terminal implements (ADR §2.4); the firmware repo copies these
fixtures for its host tests.

Envelope telemetry is advisory and never fatal: an implausible `battery_mv` is ignored (the badge keeps its last good reading, and it is reported as a `battery_reading_implausible` terminal health warning) while the batch's events are still accepted; `dropped` is clamped server-side. Only `stream` (the idempotency identity) and the per-event fields are strict.
