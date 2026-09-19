# Zigbee2MQTT through Home Assistant

**Open HA → Zigbee2MQTT.** The panel uses the current HA address and login, including Nabu Casa HTTPS. It requires an HA administrator account.

An iframe pointing at a LAN HTTP address fails inside remote HTTPS HA. The [Ingress integration](https://github.com/lovelylain/hass_ingress) proxies the frontend and its WebSocket through HA instead.

## Container installation

1. Back up `configuration.yaml`, `lovelace/zigbee2mqtt.yaml`, and `.storage/core.config_entries` in a private directory.
2. Download [Ingress 1.3.2](https://github.com/lovelylain/hass_ingress/releases/tag/1.3.2), commit `5343fab96f2c1c7a43cc3d0325254e81c26867d5`. Copy its `custom_components/ingress` into HA's `custom_components/`. This is a separate community integration, not part of Home Chat.
3. Add to `configuration.yaml`:

   ```yaml
   ingress:
     zigbee2mqtt:
       title: Zigbee2MQTT
       icon: mdi:zigbee
       require_admin: true
       ui_mode: toolbar
       url: http://127.0.0.1:8080
   ```

   This address is reached by the HA server, not the browser. It assumes HA uses host networking and Zigbee2MQTT publishes its frontend on host port 8080. Adapt the private upstream address for other network arrangements.
4. If a `lovelace-zigbee2mqtt` dashboard already exists, keep its `require_admin: true`, set `show_in_sidebar: false`, and replace its iframe URL with `/api/ingress/zigbee2mqtt/`. Existing dashboard links still work; the new sidebar entry opens `/zigbee2mqtt` directly.
5. Run HA's configuration check, restart HA, and refresh the app. Zigbee2MQTT itself does not need restarting.

No separate public hostname, port-forwarding rule, static ingress token, or browser security exception is needed. Home Chat and MQTT device control continue to use their existing connections.

## Verify

- Open the panel through the local HA address and the remote HTTPS address.
- Confirm the device list loads and receives updates over the proxied WebSocket.
- A signed-out request to `/api/ingress/zigbee2mqtt/` must return to the authenticated HA panel rather than return Zigbee2MQTT content.
- Non-admin accounts must not receive the panel or its ingress token.

This fixes frontend access. A device with missing state/position reports still needs separate diagnosis.

## Roll back

Restore the saved YAML files, remove the Ingress configuration entry and component if nothing else uses them, validate HA's configuration, then restart HA. Keep private backups and runtime credentials out of Git.
