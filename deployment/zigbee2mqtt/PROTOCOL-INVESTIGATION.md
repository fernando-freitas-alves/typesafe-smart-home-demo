# AyVolt DP104 investigation — 2026-09-19

**Status: wire format decoded; function still unidentified.** DP104 is not currently a usable position or moving/stopped signal. There is still no verified command that enables continuous position reports on `_TZE284_q9xty0ad`.

## What the packets establish

The response is a Tuya `commandDataReport` on cluster `0xEF00`, containing `{dp:104, datatype:1, data:[0]}`. Its DP payload is `68 01 00 01 00`: ID 104, Boolean type, one-byte length, false. This is a valid application Boolean, not an unparsed percentage. The packet does not include the field's name or write semantics. [Tuya's wire format](https://developer.tuya.com/en/docs/iot/tuya-zigbee-universal-docking-access-standard?id=K9ik6zvofpzql) defines the encoding but leaves product functions to the manufacturer's data model.

The retained logs contained this same response to earlier queries on shades 1 and 4. Ordinary movement reports contained DP1 command acknowledgements, DP9 targets and DP8 measurements; they did not establish DP104's function.

## Controlled comparison on shade 4

Using the existing tested position converter, the motor was requested to go **21% → 35% → 21%**. No DP104 writes, configuration changes, resets, pairing changes or firmware updates were performed. The movement was verified through fresh motor reports, without a visual observer.

| UTC time | Request or observation |
| --- | --- |
| 05:47:46 | Idle at 21%; `dataQuery` returned DP104=false. |
| 05:47:49 | `mcuVersionRequest` returned version byte 64 (`0x40`). |
| 05:47:51 | Requested 35%; DP9 acknowledged raw target 65. |
| 05:47:53 | Query during opening returned DP104=false. |
| 05:47:55 | Another query was sent; no distinct response was captured. |
| 05:48:00 | DP8 reported raw 65, measured 35% open. No intermediate DP8 was received. |
| 05:48:01 | Query after arrival again returned DP104=false. |
| 05:48:03 | Requested the original 21%; DP9 later acknowledged raw target 79. |
| 05:48:05 | Query during the return was sent; no distinct DP104 response was captured. |
| 05:48:12 | DP8 reported raw 79, measured 21% open. HA readback confirmed restoration. |

DP104 did not distinguish idle from opening in this test. That rules out using it as a simple live motion indicator on the evidence available; it does not establish whether it represents a setting, a fault flag, or another condition. Queries during travel did not produce intermediate position measurements.

The motor-controller version byte `0x40` decodes to **1.0.0** under [Tuya's MCU version format](https://developer.tuya.com/en/docs/mcu-standard-protocol/mcusdk-zigbee-uart-protocol?id=Kdg17v4544p37). This is distinct from Zigbee `genBasic.appVersion=80` (`0x50`). The earlier application-version inventory alone was not an MCU firmware-version measurement.

## Candidate meanings and rejected shortcuts

- The [original AyVolt support PR](https://github.com/Koenkk/zigbee-herdsman-converters/pull/9894) includes a `_TZE284_q9xty0ad` user report, but no DP104 definition. The [later related `_TZE204` converter](https://github.com/Koenkk/zigbee-herdsman-converters/issues/11143) likewise does not define it.
- Another motor sharing the DP1/3/8/9/11 layout, `_TZE284_r3szw0xr`, calls DP104 `dot_mode`, but encodes it as **Enum**, not our observed Boolean. Its mapping cannot be transplanted on that basis. [Converter PR](https://github.com/Koenkk/zigbee-herdsman-converters/pull/9985).
- Some [Zemismart converters](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/devices/zemismart.ts) use Boolean DP104 to set/reset a middle stroke limit. Those products use different position/direction datapoints. This is a candidate to investigate, not a verified AyVolt meaning or a reason to write it.
- Tuya's serial protocol supports querying specific DP IDs through UART command `0x28`. This is the module-to-MCU protocol, not a documented Zigbee cluster command that can simply be sent over the air. The documented Zigbee `dataQuery` command `0x03` has no payload.
- The existing HA Tuya integration's diagnostics were inspected for an AyVolt/shade product definition. None was present. Credentials and unrelated device data were kept private.

## What would resolve the remaining ambiguity

The strongest next evidence is the **exact `q9xty0ad` product's DP ID/name/type/access mapping**, available through the original app/cloud device definition if a record still exists. Zigbee2MQTT documents an [official-app workflow for finding DP names](https://www.zigbee2mqtt.io/advanced/support-new-devices/03_find_tuya_data_points.html). Standardized cloud function lists may omit manufacturer-specific fields, so the raw DP mapping matters.

Alternatively, capture the original app's known control operations or, with physical access, the module/MCU serial exchange. A write experiment should test an identified operation with a known restoration procedure; setting an unknown Boolean to true would not establish that it enables reporting and could alter limits or operating mode. No such write is implemented in the production converter.
