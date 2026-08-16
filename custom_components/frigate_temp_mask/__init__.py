"""Frigate Temporary False-Positive Mask Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import yaml
from datetime import datetime, timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.typing import ConfigType

DOMAIN = "frigate_temp_mask"
_LOGGER = logging.getLogger(__name__)

DEFAULT_FRIGATE_URL = "http://192.168.1.211:5000"
DEFAULT_PADDING = 0.20

async def _async_setup_core(hass: HomeAssistant) -> bool:
    """Register services and initialize core data structures."""
    if DOMAIN in hass.data and hass.data[DOMAIN].get("services_registered"):
        return True

    hass.data.setdefault(DOMAIN, {
        "timers": {},
        "active_masks": {},
        "services_registered": True
    })

    def _get_frigate_base_url() -> str:
        # Check if Frigate integration data is available
        if "frigate" in hass.data:
            frigate_entries = hass.config_entries.async_entries("frigate")
            for entry in frigate_entries:
                url = entry.data.get("url")
                if url:
                    return url.rstrip("/")
        return DEFAULT_FRIGATE_URL

    def _box_to_polygon(box: list[float], width: int, height: int, padding: float = DEFAULT_PADDING) -> str:
        x_norm, y_norm, w_norm, h_norm = box
        x1_px = x_norm * width
        y1_px = y_norm * height
        x2_px = (x_norm + w_norm) * width
        y2_px = (y_norm + h_norm) * height

        w = x2_px - x1_px
        h = y2_px - y1_px
        pad_x = w * padding
        pad_y_top = h * padding
        pad_y_bottom = h * (padding + 0.05)  # Extra ground margin for shadows

        x_min = max(0, int(round(x1_px - pad_x)))
        y_min = max(0, int(round(y1_px - pad_y_top)))
        x_max = min(width, int(round(x2_px + pad_x)))
        y_max = min(height, int(round(y2_px + pad_y_bottom)))

        return f"{x_min},{y_min},{x_max},{y_min},{x_max},{y_max},{x_min},{y_max}"

    def _update_state():
        active = hass.data[DOMAIN]["active_masks"]
        count = len(active)
        hass.states.async_set(
            "sensor.frigate_active_masks",
            str(count),
            {
                "friendly_name": "Frigate Active Temporary Masks",
                "icon": "mdi:shield-outline",
                "masks": list(active.values())
            }
        )

    async def async_handle_add_mask(call: ServiceCall):
        camera = call.data.get("camera", "wyze_camera")
        event_id = call.data.get("event_id", "")
        mask_id = call.data.get("mask_id") or (event_id.split("-")[0] if "-" in event_id else event_id or "manual")
        box_str = call.data.get("box", "")
        try:
            duration_hours = float(call.data.get("duration_hours", 24))
        except (ValueError, TypeError):
            duration_hours = 24.0
        padding = call.data.get("padding", DEFAULT_PADDING)

        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()

        polygon_arg = call.data.get("polygon", "")
        box_coords = None
        if box_str and box_str.strip() not in ["", "none", "unknown"]:
            try:
                box_coords = [float(v.strip()) for v in box_str.split(",")]
            except Exception:
                pass

        if not box_coords and not polygon_arg and event_id:
            try:
                async with session.get(f"{base_url}/api/events/{event_id}", timeout=10) as resp:
                    if resp.status == 200:
                        event_data = await resp.json()
                        box_coords = event_data.get("data", {}).get("box")
                        if not camera:
                            camera = event_data.get("camera", "wyze_camera")
            except Exception as e:
                _LOGGER.error("Error fetching Frigate event %s: %s", event_id, e)

        poly_str = polygon_arg
        if not box_coords and not poly_str:
            # Check if mask_id already exists in active_masks to reuse polygon and camera
            if mask_id in hass.data[DOMAIN]["active_masks"]:
                poly_str = hass.data[DOMAIN]["active_masks"][mask_id].get("polygon", "")
                if not camera or camera == "wyze_camera":
                    camera = hass.data[DOMAIN]["active_masks"][mask_id].get("camera", camera)

        if not box_coords and not poly_str:
            _LOGGER.error("No valid bounding box, polygon, or event ID found for mask addition.")
            return

        if not poly_str:
            # Fetch camera detect stream resolution
            width, height = 1920, 1080
            try:
                async with session.get(f"{base_url}/api/config", timeout=10) as resp:
                    if resp.status == 200:
                        cfg = await resp.json()
                        detect_cfg = cfg.get("cameras", {}).get(camera, {}).get("detect", {})
                        width = detect_cfg.get("width", 1920)
                        height = detect_cfg.get("height", 1080)
            except Exception as e:
                _LOGGER.warning("Using fallback resolution 1920x1080: %s", e)

            poly_str = _box_to_polygon(box_coords, width, height, padding)
        tag = f"# TEMP_MASK_{mask_id}"

        # Fetch raw config
        raw_config = ""
        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = await resp.text()
        except Exception as e:
            _LOGGER.error("Failed to read Frigate config: %s", e)
            return

        # Remove existing instance if replacing
        if tag in raw_config:
            lines = [l for l in raw_config.splitlines() if tag not in l]
            raw_config = "\n".join(lines) + "\n"

        target_needle = "objects:\n  mask:"
        new_entry = f"objects:\n  mask:\n  - {poly_str} {tag}"

        if target_needle in raw_config:
            updated_config = raw_config.replace(target_needle, new_entry, 1)
        else:
            data = yaml.safe_load(raw_config) or {}
            data.setdefault("objects", {}).setdefault("mask", [])
            if isinstance(data["objects"]["mask"], list):
                data["objects"]["mask"].append(f"{poly_str} {tag}")
            updated_config = yaml.dump(data, default_flow_style=False, sort_keys=False)

        # Save and restart Frigate process
        try:
            async with session.post(
                f"{base_url}/api/config/save",
                data=updated_config.encode("utf-8"),
                headers={"Content-Type": "text/plain"},
                timeout=15
            ) as resp:
                resp.raise_for_status()
            
            # Restart backend to load into memory
            async with session.post(f"{base_url}/api/restart", timeout=10) as restart_resp:
                _LOGGER.info("Frigate restart triggered: %s", restart_resp.status)
        except Exception as e:
            _LOGGER.error("Failed to save Frigate config: %s", e)
            return

        # Cancel any previous timer for this mask
        if mask_id in hass.data[DOMAIN]["timers"]:
            hass.data[DOMAIN]["timers"][mask_id]()

        # Record active mask metadata
        expires_at = datetime.utcnow() + timedelta(hours=duration_hours)
        hass.data[DOMAIN]["active_masks"][mask_id] = {
            "mask_id": mask_id,
            "camera": camera,
            "polygon": poly_str,
            "duration_hours": duration_hours,
            "expires_at": expires_at.isoformat() + "Z"
        }
        _update_state()

        # Schedule automatic expiration
        async def _expire_callback(_now):
            _LOGGER.info("Temporary mask %s expired after %s hours, pruning...", mask_id, duration_hours)
            await async_handle_remove_mask(ServiceCall(DOMAIN, "remove_mask", {"mask_id": mask_id}))

        duration_seconds = int(duration_hours * 3600)
        unsub = async_call_later(hass, duration_seconds, _expire_callback)
        hass.data[DOMAIN]["timers"][mask_id] = unsub

        _LOGGER.info("Added temporary mask %s for %s (%s hours)", mask_id, camera, duration_hours)

    async def async_handle_remove_mask(call: ServiceCall):
        mask_id = call.data.get("mask_id")
        if not mask_id:
            return

        # Cancel expiration timer
        if mask_id in hass.data[DOMAIN]["timers"]:
            hass.data[DOMAIN]["timers"][mask_id]()
            del hass.data[DOMAIN]["timers"][mask_id]

        if mask_id in hass.data[DOMAIN]["active_masks"]:
            del hass.data[DOMAIN]["active_masks"][mask_id]
        _update_state()

        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()
        tag = f"TEMP_MASK_{mask_id}"

        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = await resp.text()
                else:
                    return

            if tag not in raw_config:
                return

            lines = raw_config.splitlines()
            clean_lines = [l for l in lines if tag not in l]
            updated_config = "\n".join(clean_lines) + "\n"

            # Save WITHOUT restart to avoid interrupting live video/detections
            async with session.post(
                f"{base_url}/api/config/save",
                data=updated_config.encode("utf-8"),
                headers={"Content-Type": "text/plain"},
                timeout=15
            ) as save_resp:
                _LOGGER.info("Removed temporary mask %s (saved to config without restart)", mask_id)
        except Exception as e:
            _LOGGER.error("Failed to remove mask %s: %s", mask_id, e)

    async def async_handle_prune_all(call: ServiceCall):
        # Cancel all timers
        for unsub in hass.data[DOMAIN]["timers"].values():
            unsub()
        hass.data[DOMAIN]["timers"].clear()
        hass.data[DOMAIN]["active_masks"].clear()
        _update_state()

        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()

        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = await resp.text()
                else:
                    return

            if "TEMP_MASK_" not in raw_config:
                return

            lines = raw_config.splitlines()
            clean_lines = [l for l in lines if "TEMP_MASK_" not in l]
            updated_config = "\n".join(clean_lines) + "\n"

            async with session.post(
                f"{base_url}/api/config/save",
                data=updated_config.encode("utf-8"),
                headers={"Content-Type": "text/plain"},
                timeout=15
            ) as save_resp:
                _LOGGER.info("Pruned all temporary masks (saved to config without restart)")
        except Exception as e:
            _LOGGER.error("Failed to prune masks: %s", e)

    hass.services.async_register(DOMAIN, "add_mask", async_handle_add_mask)
    hass.services.async_register(DOMAIN, "remove_mask", async_handle_remove_mask)
    hass.services.async_register(DOMAIN, "prune_all", async_handle_prune_all)

    _update_state()
    return True


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Frigate Temporary Mask component via YAML."""
    await _async_setup_core(hass)

    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN,
                context={"source": "import"},
                data=config.get(DOMAIN, {}) or {},
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Frigate Temporary Mask from a config entry."""
    await _async_setup_core(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return True
