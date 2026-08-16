"""Frigate Temporary False-Positive Mask Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import re
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
        "pending_restart_masks": {},
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
        active = hass.data[DOMAIN].get("active_masks", {})
        pending = hass.data[DOMAIN].get("pending_restart_masks", {})
        count = len(active)
        pending_count = len(pending)
        hass.states.async_set(
            "sensor.frigate_active_masks",
            str(count),
            {
                "friendly_name": "Frigate Active Temporary Masks",
                "icon": "mdi:vector-square-remove",
                "masks": list(active.values()),
                "pending_restart_masks": list(pending.values()),
                "restart_pending": pending_count > 0,
                "pending_count": pending_count,
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
        label_val = call.data.get("label", "")
        if not label_val and "event_data" in locals() and isinstance(event_data, dict):
            label_val = event_data.get("label", "")

        # Fetch raw config
        raw_config = ""
        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = await resp.text()
        except Exception as e:
            _LOGGER.error("Failed to read Frigate config: %s", e)
            return

        def _inject_temp_mask(config_text: str, polygon: str, mask_tag: str, obj_label: str = "") -> str:
            lines = [l for l in config_text.splitlines() if mask_tag not in l]
            cleaned = "\n".join(lines) + "\n"
            obj_label = obj_label.lower().strip() if obj_label else ""
            if obj_label in ["people", "person", "human", "persons"]:
                obj_label = "person"

            if obj_label:
                f_match = re.search(r"^([ ]*)filters:\s*$", cleaned, re.MULTILINE)
                if f_match:
                    f_indent = f_match.group(1)
                    label_pattern = rf"^{f_indent}  {re.escape(obj_label)}:\s*$"
                    l_match = re.search(label_pattern, cleaned, re.MULTILINE)
                    if l_match:
                        label_pos = l_match.end()
                        rest = cleaned[label_pos:]
                        mask_match = re.search(rf"^([ ]+)mask:\s*$", rest, re.MULTILINE)
                        next_peer = re.search(rf"^{f_indent}  [a-zA-Z0-9_-]+:\s*$", rest, re.MULTILINE)
                        
                        if mask_match and (not next_peer or mask_match.start() < next_peer.start()):
                            mask_indent = mask_match.group(1)
                            mask_line_end = label_pos + mask_match.end()
                            after_mask = cleaned[mask_line_end:]
                            
                            item_match = re.search(r"^\n?([ ]*)- ", after_mask)
                            item_indent = item_match.group(1) if item_match else mask_indent
                            
                            insertion = f"\n{item_indent}- {polygon} {mask_tag}"
                            return cleaned[:mask_line_end] + insertion + cleaned[mask_line_end:]
                        else:
                            label_indent = f_indent + "  "
                            mask_indent = label_indent + "  "
                            item_indent = mask_indent
                            insertion = f"\n{mask_indent}mask:\n{item_indent}- {polygon} {mask_tag}"
                            return cleaned[:label_pos] + insertion + cleaned[label_pos:]
                    else:
                        f_pos = f_match.end()
                        label_indent = f_indent + "  "
                        mask_indent = label_indent + "  "
                        item_indent = mask_indent
                        insertion = f"\n{label_indent}{obj_label}:\n{mask_indent}mask:\n{item_indent}- {polygon} {mask_tag}"
                        return cleaned[:f_pos] + insertion + cleaned[f_pos:]

            obj_match = re.search(r"^([ ]*)objects:\s*$", cleaned, re.MULTILINE)
            if obj_match:
                obj_indent = obj_match.group(1)
                rest = cleaned[obj_match.end():]
                mask_match = re.search(rf"^([ ]+)mask:\s*$", rest, re.MULTILINE)
                if mask_match:
                    mask_line_end = obj_match.end() + mask_match.end()
                    after_mask = cleaned[mask_line_end:]
                    item_match = re.search(r"^\n?([ ]*)- ", after_mask)
                    item_indent = item_match.group(1) if item_match else mask_match.group(1)
                    insertion = f"\n{item_indent}- {polygon} {mask_tag}"
                    return cleaned[:mask_line_end] + insertion + cleaned[mask_line_end:]
                else:
                    insertion = f"\n{obj_indent}  mask:\n{obj_indent}  - {polygon} {mask_tag}"
                    return cleaned[:obj_match.end()] + insertion + cleaned[obj_match.end():]

            return cleaned + f"\nobjects:\n  mask:\n  - {polygon} {mask_tag}\n"

        updated_config = _inject_temp_mask(raw_config, poly_str, tag, label_val)

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
                # Restart applied all pending changes
                hass.data[DOMAIN]["pending_restart_masks"].clear()
        except Exception as e:
            _LOGGER.error("Failed to save Frigate config: %s", e)
            return

        # Cancel any previous timer for this mask
        if mask_id in hass.data[DOMAIN]["timers"]:
            hass.data[DOMAIN]["timers"][mask_id]()

        # Record active mask metadata
        expires_at = datetime.utcnow() + timedelta(hours=duration_hours)
        
        # Remove from pending if re-adding
        hass.data[DOMAIN]["pending_restart_masks"].pop(mask_id, None)

        hass.data[DOMAIN]["active_masks"][mask_id] = {
            "mask_id": mask_id,
            "camera": camera,
            "polygon": poly_str,
            "duration_hours": duration_hours,
            "expires_at": expires_at.isoformat() + "Z",
            "event_id": event_id or mask_id,
            "label": label_val,
            "box": box_coords if box_coords else None,
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
            removed_mask = dict(hass.data[DOMAIN]["active_masks"].pop(mask_id))
            removed_mask["removed_at"] = datetime.utcnow().isoformat() + "Z"
            hass.data[DOMAIN]["pending_restart_masks"][mask_id] = removed_mask
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

        for m_id, m_val in hass.data[DOMAIN]["active_masks"].items():
            removed_mask = dict(m_val)
            removed_mask["removed_at"] = datetime.utcnow().isoformat() + "Z"
            hass.data[DOMAIN]["pending_restart_masks"][m_id] = removed_mask
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

    async def async_handle_restart(call: ServiceCall):
        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()
        try:
            async with session.post(f"{base_url}/api/restart", timeout=10) as resp:
                _LOGGER.info("Frigate restart triggered via service: %s", resp.status)
                hass.data[DOMAIN]["pending_restart_masks"].clear()
                _update_state()
        except Exception as e:
            _LOGGER.error("Failed to restart Frigate: %s", e)

    hass.services.async_register(DOMAIN, "add_mask", async_handle_add_mask)
    hass.services.async_register(DOMAIN, "remove_mask", async_handle_remove_mask)
    hass.services.async_register(DOMAIN, "prune_all", async_handle_prune_all)
    hass.services.async_register(DOMAIN, "restart", async_handle_restart)
    hass.services.async_register(DOMAIN, "restart_frigate", async_handle_restart)

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
