"""Native, authenticated Home Assistant panel backed by the private chat bridge."""
from pathlib import Path

import aiohttp
from aiohttp import web
import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ, POLICY_CONTROL
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.helpers import area_registry, device_registry, entity_registry, label_registry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import homeassistant.helpers.config_validation as cv

DOMAIN = "typesafe_chat"
CONFIG_SCHEMA = vol.Schema({DOMAIN: vol.Schema({
    vol.Required("bridge_token"): cv.string,
    vol.Optional("backend_url", default="http://127.0.0.1:5189"): cv.url,
})}, extra=vol.ALLOW_EXTRA)
DOMAINS = {"light", "fan", "climate", "cover", "media_player", "switch", "lock", "sensor", "binary_sensor"}
ATTRIBUTES = {"friendly_name", "brightness", "supported_color_modes", "supported_features", "device_class", "temperature", "current_temperature", "hvac_modes", "min_temp", "max_temp", "target_temp_step", "current_position", "unit_of_measurement", "volume_level", "percentage", "entity_id", "light", "remaining_minutes", "protected"}
OPERATIONS = {"bootstrap", "new", "open", "send", "apply", "cancel", "location", "rename", "archive"}


def inventory_for(hass, user):
    """Export only entities readable by this authenticated HA user."""
    registry = entity_registry.async_get(hass)
    hardware = device_registry.async_get(hass)
    areas = area_registry.async_get(hass)
    labels = label_registry.async_get(hass)
    label_ids = set()
    states, entities, device_ids, area_ids, controllable = [], [], set(), set(), []
    for state in hass.states.async_all():
        if state.domain not in DOMAINS or not user.permissions.check_entity(state.entity_id, POLICY_READ):
            continue
        attrs = {key: value for key, value in state.attributes.items() if key in ATTRIBUTES or key == "icon"}
        if isinstance(attrs.get("entity_id"), (list, tuple)):
            attrs["entity_id"] = [eid for eid in attrs["entity_id"] if user.permissions.check_entity(eid, POLICY_READ)]
        states.append({"entity_id": state.entity_id, "state": state.state, "attributes": attrs})
        if user.permissions.check_entity(state.entity_id, POLICY_CONTROL):
            controllable.append(state.entity_id)
        entry = registry.async_get(state.entity_id)
        if entry:
            entities.append({"entity_id": entry.entity_id, "name": entry.name, "area_id": entry.area_id, "device_id": entry.device_id, "aliases": list(entry.aliases), "icon": entry.icon, "original_icon": entry.original_icon, "labels": sorted(entry.labels), "disabled_by": bool(entry.disabled_by), "hidden_by": bool(entry.hidden_by), "entity_category": bool(entry.entity_category)})
            label_ids.update(entry.labels)
            if entry.area_id:
                area_ids.add(entry.area_id)
            if entry.device_id:
                device_ids.add(entry.device_id)
    devices = []
    for device_id in device_ids:
        if device := hardware.async_get(device_id):
            devices.append({"id": device.id, "area_id": device.area_id, "labels": sorted(device.labels), "disabled_by": bool(device.disabled_by)})
            label_ids.update(device.labels)
            if device.area_id:
                area_ids.add(device.area_id)
    # Only export labels attached to readable entities or their hardware.
    attached_labels = [{"label_id": label.label_id, "name": label.name} for label in labels.labels.values() if label.label_id in label_ids]
    return {"states": states, "entities": entities, "devices": devices, "labels": attached_labels, "areas": [{"area_id": area.id, "name": area.name} for area in areas.areas.values() if area.id in area_ids], "temperatureUnit": hass.config.units.temperature_unit, "controlEntities": controllable}


class ChatView(HomeAssistantView):
    url = "/api/typesafe_chat"
    name = "api:typesafe_chat"
    requires_auth = True

    def __init__(self, hass, config):
        self.hass, self.config = hass, config

    async def post(self, request):
        user = request["hass_user"]
        if request.content_length and request.content_length > 16000:
            return self.json({"error": "Message is too large."}, status_code=413)
        try:
            value = await request.json()
        except (ValueError, web.HTTPRequestEntityTooLarge):
            return self.json({"error": "Use a valid chat request."}, status_code=400)
        if not isinstance(value, dict) or value.get("op") not in OPERATIONS:
            return self.json({"error": "Unknown chat operation."}, status_code=400)
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            return self.json({"error": "Reconnect to Home Assistant."}, status_code=401)
        # Identity and permissions come from HA, never browser form fields.
        payload = {"actor": {"id": user.id, "name": user.name or "Home Assistant user"}, "input": value, "accessToken": authorization[7:], "inventory": inventory_for(self.hass, user)}
        try:
            async with async_get_clientsession(self.hass).post(
                self.config["backend_url"].rstrip("/") + "/chat", json=payload,
                headers={"Authorization": "Bearer " + self.config["bridge_token"]},
                timeout=aiohttp.ClientTimeout(total=85), allow_redirects=False,
            ) as response:
                result = await response.json()
                return self.json(result, status_code=response.status, headers={"Cache-Control": "no-store"})
        except (aiohttp.ClientError, TimeoutError, ValueError):
            return self.json({"error": "Home chat is unavailable. Reopen the chat to recover its latest result before repeating an action."}, status_code=503)


class AiSettingsView(HomeAssistantView):
    url = "/api/typesafe_chat/llm"
    name = "api:typesafe_chat:llm"
    requires_auth = True

    def __init__(self, hass, config):
        self.hass, self.config = hass, config

    async def post(self, request):
        user = request["hass_user"]
        if request.content_length and request.content_length > 2000:
            return self.json({"error": "Settings request is too large."}, status_code=413)
        try:
            value = await request.json()
        except (ValueError, web.HTTPRequestEntityTooLarge):
            return self.json({"error": "Use a valid settings request."}, status_code=400)
        if not isinstance(value, dict) or value.get("op") not in {"status", "connect", "cancel", "disconnect", "model"}:
            return self.json({"error": "Unknown settings operation."}, status_code=400)
        if value["op"] != "status" and not user.is_admin:
            return self.json({"error": "Only a Home Assistant administrator can change shared AI settings."}, status_code=403)
        # No client-supplied roles, credentials, or arbitrary Codex RPC methods.
        payload = {"actor": {"id": user.id, "isAdmin": user.is_admin}, "input": value}
        try:
            async with async_get_clientsession(self.hass).post(
                self.config["backend_url"].rstrip("/") + "/llm", json=payload,
                headers={"Authorization": "Bearer " + self.config["bridge_token"]},
                timeout=aiohttp.ClientTimeout(total=45), allow_redirects=False,
            ) as response:
                result = await response.json()
                return self.json(result, status_code=response.status, headers={"Cache-Control": "no-store"})
        except (aiohttp.ClientError, TimeoutError, ValueError):
            return self.json({"error": "AI settings are unavailable. Please try again."}, status_code=503)


async def async_setup(hass, config):
    settings = config[DOMAIN]
    hass.http.register_view(ChatView(hass, settings))
    hass.http.register_view(AiSettingsView(hass, settings))
    await hass.http.async_register_static_paths([StaticPathConfig("/typesafe-chat", str(Path(__file__).parent / "www"), False)])
    await async_register_panel(hass, frontend_url_path="home-chat", webcomponent_name="typesafe-chat-panel", sidebar_title="Home chat", sidebar_icon="mdi:chat-outline", module_url="/typesafe-chat/panel.js?v=1", config={}, require_admin=False)
    return True
