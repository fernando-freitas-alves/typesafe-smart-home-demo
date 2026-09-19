# AyVolt terrace shade integration

This converter supports **TS0601 / `_TZE284_q9xty0ad`**, preserving the existing `AyVolt-Curtain` identity and paired devices. It replaces the generic legacy Tuya cover converter, which ignored the actual-position reports from these motors.

## Install or update

1. Back up Zigbee2MQTT's data directory, including its configuration, database, state cache, and existing external converter. Keep that backup private: it contains Zigbee credentials.
2. Put `ayvolt_cover.js` in Zigbee2MQTT's `data/external_converters/` directory. Replace the previous file; do not leave two converters matching the same fingerprint.
3. Run `test-converter.cjs` with the installed Zigbee2MQTT dependencies:

   ```sh
   docker exec -i zigbee2mqtt node < deployment/zigbee2mqtt/test-converter.cjs
   ```

4. Restart Zigbee2MQTT and check for `Loaded external converter 'ayvolt_cover.js'`. Initialization uses the supported Tuya handshake. Re-pairing and changing HA entity IDs are unnecessary.
5. Verify one motor's actual direction and position with an observer, then validate the remaining motors. Keep their HA devices assigned to the appropriate area.

For a staged converter, set `AYVOLT_CONVERTER` to its path **inside** the container when running the tests. The deployed converter was tested with Zigbee2MQTT **2.12.1** and zigbee-herdsman-converters **26.76.0**; re-run the tests before upgrading.

## Commands and reports

| Function | MQTT payload | Tuya datapoint |
| --- | --- | --- |
| Open / close / stop | `{"state":"OPEN"}`, `{"state":"CLOSE"}`, `{"state":"STOP"}` | DP1 enum: 0 / 2 / 1 |
| Target percentage | `{"position":35}` | DP9 = 65 (35% open), integer 0–100 |
| Actual position | Device report → `position`, `state` | **DP8** |
| Reported target | Device report → `target_position` | DP9; never overwrites actual position |
| Movement direction | Device report → `motor_state` | DP3: 0 opening / 1 closing |
| Motor rotation setting | `{"motor_direction":"normal"}` or `"reversed"` | DP11 |

Publish commands to `zigbee2mqtt/<friendly_name>/set`, one control per request. Normal HA convention is **0% closed, 100% open**. This `_TZE284` motor reports the reverse: raw **0 = open, 100 = closed**. The converter translates measured and target positions; it preserves the physically verified OPEN enum 0. The `invert_cover` option reverses both commands and percentages if needed for a particular installation; it does not change the motor's physical rotation setting.

Every outbound command gets a fresh Tuya transaction number through the library's per-device sequence allocator. The generic datapoint writer in the tested library version hardcodes `seq=1`; this converter bypasses that writer so an immediate Stop is distinguishable from the preceding Open/Close. Transport errors propagate without automatic movement retries.

The motor-state field is the **last reported movement direction**, not proof the motor is still moving. Unsupported values do not invent a stopped state. Position sentinels/out-of-range values are ignored. No battery percentage, calibration controls, limit programming, or other undocumented capabilities are fabricated.

**A target is not a measurement.** Sending a command, receiving a command acknowledgement, or receiving DP9 never produces a successful-position claim. Only an actual DP8 report updates the cover's measured position and open/closed state. Home Chat separately reports whether its requested result was observed.

These motors do not have verified on-demand position reads, so no misleading `/get` control is advertised. A first installation may remain unknown until a fresh report, usually after movement. Once received, Zigbee2MQTT's normal state cache/MQTT integration supplies subsequent state; never seed a current position from an old log.

### Position reporting during travel

The 2026-09-19 investigation found endpoint reports, not continuous measured positions. For example, a 41% → 0% closing trip acknowledged the target immediately and reported DP8 about 22 seconds later, with no intermediate DP8 packets. The floorplan can animate a clearly labelled local estimate between reports; that estimate never becomes the converter's measured position.

All five installed `_TZE284_q9xty0ad` motors use application version 80 and hardware version 1. Their endpoint 1 input clusters are 0x0004, 0x0005, 0xEF00, 0x0000 and 0xED00: **no standard Window Covering cluster (0x0102)** is advertised, so standard cover-attribute polling/reporting cannot simply be enabled.

A single read-only Tuya `dataQuery` was tested on shade 4 at 05:30:53 UTC. It produced a `commandDataReport` containing **DP104, boolean false**, with no measured DP8 response in logs through 05:33:00. HA remained at its previous measured 21%, with no new position timestamp. The test sent no movement or configuration writes. DP104's meaning is unverified and it is neither mapped nor written by this converter.

This does not establish that every possible firmware mechanism is unavailable, but it provides no basis for enabling periodic queries or promising live measurements. Keep `/get` unadvertised until a repeatable read actually returns DP8. Any further protocol work should capture raw reports during an authorized movement and verify a candidate read/reporting method before changing the production converter. The [upstream related `_TZE204` device](https://www.zigbee2mqtt.io/devices/TZE204_q9xty0ad.html) also documents position as unavailable through `/get`; it is a different variant, so our live evidence takes precedence.

**Follow-up:** a controlled 21% → 35% → 21% test queried shade 4 during travel. DP104 remained false while idle and opening; actual DP8 reports still arrived only at the destinations. A separate MCU-version query returned `0x40` (1.0.0). See the [packet analysis and remaining hypotheses](PROTOCOL-INVESTIGATION.md). DP104's function remains unidentified; the production converter has no speculative mapping or write for it.

## Evidence and troubleshooting

- Live logs from this manufacturer variant contain actual DP8 reports (including 0, 64, and 100) and separate DP9 target acknowledgements.
- Shade 1 physically opened with DP1 enum 0, reported target DP9=0, and reached DP8=0. This establishes the position polarity for this installation.
- **Verified on shade 2 (2026-09-19):** after the sequence fix, an observed 15-second Open → 7-second Close → Stop test rose, reversed, and stopped partway. DP1 acknowledged all three commands; DP8=87 then reached HA as **13% open**. The initial Stop failure was on shade 1 with the generic constant-sequence writer.
- **Percentage control verified on shade 2:** 13% → 30% → 13% stopped automatically at both targets, confirmed by the observer. Target DP9 values 70/87 left the previous actual position unchanged; later measured DP8 values 70/87 updated HA to 30%/13%. No separate Stop was sent during this test.
- **Verified on shade 1 (2026-09-19):** the observer confirmed automatic arrival at 40% open, then a visible Close → Stop at 25% → pause → return toward 40% test. This verifies Stop on the motor that originally ignored it. One return measured 41% for the 40% target (DP8=59 versus DP9=60); preserve the measured value rather than replacing it with the requested target. Home Chat already accepts a one-point difference for percentage requests.
- **Verified on shade 3 (2026-09-19):** the observer confirmed Open → Close → Stop, with a fresh HA position of 15%. Percentage control then reached 30% and returned to 15%; the observed repeat paused at a measured 31% for the 30% target and stopped automatically at 15%. No separate Stop was used for the percentage test.
- **Verified on shade 5 (2026-09-19):** Close from an unknown state produced a measured 0% position. The observer confirmed a brief Open → Stop at 6%, followed by automatic percentage stops at 12% and 8%, with a 10-second pause between them. HA reported both percentage targets exactly; the small movements kept the shade visible to the observer.
- **Verified through motor reports on shade 4 (2026-09-19):** starting unknown, a 20% target produced measured DP8=80 (20% open). Brief Open → Stop reached 26%; Close → Stop reached 21%. Both intermediate positions remained stable through a five-second check. Percentage requests then reached 10% and 21% for a 20% target. Raw Zigbee reports separately acknowledged commands (DP1), targets (DP9), and measured positions (DP8). This was an authorized automated test without a visual observer.
- All five now have measured positions in HA. A live registry check confirmed they share `TS0601 / _TZE284_q9xty0ad`, application version 80, hardware version 1, and completed Zigbee interviews. All use this converter and belong to Terrace. Shades 1, 2, 3, and 5 also have observer-confirmed movement; shade 4 is verified through device reports only.
- The automated checks validate command bytes against the installed converter library, decode those report values, check inversion and invalid data, and verify that sending a command does not optimistically change actual state. They do not substitute for physical testing.
- If the motor moves but HA stays unknown, inspect DP8 packets, the converted MQTT payload, and HA's MQTT cover position subscription in that order.
- If direction is wrong, stop the motor and check `invert_cover` against physical observation. Do not experiment with calibration or limit settings.
- To roll back, restore the previous converter from backup and restart Zigbee2MQTT. Do not restore the paired-device database unless it was actually changed.

Protocol reference: [upstream AyVolt definition](https://www.zigbee2mqtt.io/devices/TZE204_q9xty0ad.html) and [position-versus-target discussion](https://github.com/Koenkk/zigbee2mqtt/discussions/28413). The upstream definition covers the related `_TZE204` variant; `_TZE284` datapoints must be verified against actual device reports as above.
