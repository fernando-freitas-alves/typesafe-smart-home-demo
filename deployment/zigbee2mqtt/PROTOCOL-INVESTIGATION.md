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

The missing evidence is the **exact `q9xty0ad` product's DP ID/name/type/access mapping**. Manufacturer protocol documentation, matching firmware, or a capture correlating known operations with raw reports could establish it. The investigation must preserve the current Zigbee pairing: the owner ruled out switching to Wi-Fi/original-app mode.

With physical access, capturing the module/MCU serial exchange is another source of evidence. A write experiment should test an identified operation with a known restoration procedure; setting an unknown Boolean to true would not establish that it enables reporting and could alter limits or operating mode. No such write is implemented in the production converter.

## Follow-up: original app/cloud definition

A fresh, read-only query through the Tuya sharing SDK and HA's existing valid session confirmed that the connected account has **no matching shade record**. This checked the live home/device lists, not only HA's cached diagnostics. No token refresh, device command, or configuration change was performed.

The installed HA sharing SDK retrieves specifications and raw status strategy by **cloud device ID**. A Zigbee IEEE address or the manufacturer string cannot be substituted for that ID.

If a record is available, retrieve its product ID and complete DP mapping, including each field's numeric ID, code/name, type, and read/write access. Check that the product is `q9xty0ad` before assigning a meaning to DP104. Tuya's [app SDK also exposes product thing-model lookup](https://developer.tuya.com/en/docs/app-development/devicemanage?id=Ka6ki8r2rfiuu), but that is a separate SDK capability, not an endpoint provided by HA's sharing client. Standardized function lists alone may omit the custom field.

**Closed for this installation:** the owner clarified that the original-app route would require Wi-Fi mode and excluded that approach. Do not keep asking for a Tuya account, re-pair the shades, or switch their radio mode to obtain a schema. A Wi-Fi variant's field mapping would also require independent verification against the Zigbee product.

## Follow-up: Zigbee-only capability discovery

Read-only ZCL global requests were sent to shade 4 on the existing coordinator at **06:10 UTC**. The outbound frames were checked to contain only Read Attributes (`0x00`), Discover Attributes (`0x0c`), Discover Commands Received (`0x11`), or Discover Commands Generated (`0x13`). No cluster-specific control command or DP write was sent.

| Request | Observed result |
| --- | --- |
| Basic cluster: read application version, manufacturer, model and software build | No correlated response within six seconds. |
| Tuya `0xef00`: Discover Attributes | No correlated response within six seconds. |
| Tuya `0xef00`: Discover Commands Received | Raw response `18 c2 0b 11 01`: Default Response to `0x11`, status `0x01` (FAILURE). |
| Tuya `0xef00`: Discover Commands Generated | Raw response `18 c3 0b 13 01`: Default Response to `0x13`, status `0x01` (FAILURE). |
| Private `0xed00`: Discover Attributes | No correlated response within six seconds. |
| Basic cluster: Discover Attributes | No correlated response within six seconds. |

The bridge returned `status: ok` for the two Default Responses because it successfully received a packet; decoding those packets shows that the **device rejected the discovery requests**. Timeouts do not prove that attributes are absent, especially because the Basic-cluster read also timed out. No usable attribute or command catalog was recovered. The device continued sending its existing Basic-cluster reports afterward, and HA's last measured position remained 21%.

The [public Zigbee OTA index](https://github.com/Koenkk/zigbee-OTA/blob/master/index.json) was also checked for `q9xty0ad`/AyVolt; no matching record was found. This is not evidence that firmware cannot be obtained from another source. No firmware was installed or requested from the motor.

**Result:** neither cloud lookup nor standard Zigbee discovery supplied the missing field definition. DP104 remains unidentified, and there is still no verified way to enable continuous measured position reports. The production converter and labelled estimated UI animation are unchanged.
