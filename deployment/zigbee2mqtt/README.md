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
| Target percentage | `{"position":35}` | DP9, integer 0–100 |
| Actual position | Device report → `position`, `state` | **DP8** |
| Reported target | Device report → `target_position` | DP9; never overwrites actual position |
| Movement direction | Device report → `motor_state` | DP3: 0 opening / 1 closing |
| Motor rotation setting | `{"motor_direction":"normal"}` or `"reversed"` | DP11 |

Publish commands to `zigbee2mqtt/<friendly_name>/set`. Normal HA convention is **0% closed, 100% open**. The `invert_cover` option adjusts command and reported coordinates together; it does not change the motor's physical rotation setting.

The motor-state field is the **last reported movement direction**, not proof the motor is still moving. Unsupported values do not invent a stopped state. Position sentinels/out-of-range values are ignored. No battery percentage, calibration controls, limit programming, or other undocumented capabilities are fabricated.

**A target is not a measurement.** Sending a command, receiving a command acknowledgement, or receiving DP9 never produces a successful-position claim. Only an actual DP8 report updates the cover's measured position and open/closed state. Home Chat separately reports whether its requested result was observed.

These motors do not have verified on-demand position reads, so no misleading `/get` control is advertised. A first installation may remain unknown until a fresh report, usually after movement. Once received, Zigbee2MQTT's normal state cache/MQTT integration supplies subsequent state; never seed a current position from an old log.

## Evidence and troubleshooting

- Live logs from this manufacturer variant contain actual DP8 reports (including 0, 64, and 100) and separate DP9 target acknowledgements.
- The automated checks validate command bytes against the installed converter library, decode those report values, check inversion and invalid data, and verify that sending a command does not optimistically change actual state. They do not substitute for physical testing.
- If the motor moves but HA stays unknown, inspect DP8 packets, the converted MQTT payload, and HA's MQTT cover position subscription in that order.
- If direction is wrong, stop the motor and check `invert_cover` against physical observation. Do not experiment with calibration or limit settings.
- To roll back, restore the previous converter from backup and restart Zigbee2MQTT. Do not restore the paired-device database unless it was actually changed.

Protocol reference: [upstream AyVolt definition](https://www.zigbee2mqtt.io/devices/TZE204_q9xty0ad.html) and [position-versus-target discussion](https://github.com/Koenkk/zigbee2mqtt/discussions/28413). The upstream definition covers the related `_TZE204` variant; `_TZE284` datapoints must be verified against actual device reports as above.
