"""Frigate Temporary False-Positive Mask Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import re
import yaml
from datetime import datetime, timedelta, timezone

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.typing import ConfigType

DOMAIN = "frigate_temp_mask"
_LOGGER = logging.getLogger(__name__)

DEFAULT_FRIGATE_URL = "http://192.168.1.211:5000"
DEFAULT_PADDING = 0.20
SYNC_INTERVAL_SECONDS = 30


def _parse_iso_to_timestamp(iso_str: str | None) -> float | None:
    """Parse ISO formatted timestamp string to float epoch seconds."""
    if not iso_str:
        return None
    try:
        clean_str = iso_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean_str).timestamp()
    except Exception:
        return None


async def _async_setup_core(hass: HomeAssistant) -> bool:
    """Register services and initialize core data structures."""
    hass.data.setdefault(DOMAIN, {})
    domain_data = hass.data[DOMAIN]
    domain_data.setdefault("timers", {})
    domain_data.setdefault("active_masks", {})
    domain_data.setdefault("pending_restart_masks", {})
    domain_data.setdefault("services_registered", False)
    domain_data.setdefault("unsub_sync", None)

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
        active = domain_data.get("active_masks", {})
        pending = domain_data.get("pending_restart_masks", {})
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

    async def _async_sync_frigate_state() -> None:
        """Synchronize mask state with running Frigate process uptime and active config."""
        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()

        frigate_boot_ts: float | None = None
        try:
            async with session.get(f"{base_url}/api/stats", timeout=5) as resp:
                if resp.status == 200:
                    stats = await resp.json()
                    service_info = stats.get("service", {})
                    uptime = service_info.get("uptime")
                    last_updated = service_info.get("last_updated")
                    if uptime is not None:
                        ref_time = float(last_updated) if last_updated else datetime.now(timezone.utc).timestamp()
                        frigate_boot_ts = ref_time - float(uptime)
        except Exception as e:
            _LOGGER.debug("Could not fetch Frigate stats for restart sync: %s", e)

        # 1. Prune pending restart masks if Frigate booted after the mask was removed
        pending = domain_data.get("pending_restart_masks", {})
        if pending and frigate_boot_ts is not None:
            to_prune: list[str] = []
            for mask_id, mask_data in list(pending.items()):
                removed_at_str = mask_data.get("removed_at")
                removed_ts = _parse_iso_to_timestamp(removed_at_str)
                if removed_ts is not None:
                    # If Frigate booted after (or within 10s of) removal, Frigate loaded without the mask
                    if removed_ts <= frigate_boot_ts + 10:
                        to_prune.append(mask_id)
                else:
                    # No timestamp, but Frigate has booted
                    to_prune.append(mask_id)

            if to_prune:
                for mask_id in to_prune:
                    _LOGGER.info(
                        "Frigate restarted after mask %s removal (Frigate boot time: %s). Auto-cleared pending restart state.",
                        mask_id,
                        datetime.fromtimestamp(frigate_boot_ts, timezone.utc).isoformat()
                    )
                    pending.pop(mask_id, None)
                _update_state()

        # 2. Check for any active masks whose duration expired while offline or timers stalled
        active = domain_data.get("active_masks", {})
        if active:
            now_ts = datetime.now(timezone.utc).timestamp()
            expired_ids: list[str] = []
            for mask_id, mask_data in list(active.items()):
                exp_str = mask_data.get("expires_at")
                exp_ts = _parse_iso_to_timestamp(exp_str)
                if exp_ts is not None and exp_ts <= now_ts:
                    expired_ids.append(mask_id)

            for mask_id in expired_ids:
                _LOGGER.info("Active mask %s expired during sync check, pruning...", mask_id)
                await async_handle_remove_mask(ServiceCall(DOMAIN, "remove_mask", {"mask_id": mask_id}))

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
        label_val = call.data.get("label", "")

        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()

        polygon_arg = call.data.get("polygon", "")
        box_coords = None
        if box_str and box_str.strip() not in ["", "none", "unknown"]:
            try:
                box_coords = [float(v.strip()) for v in box_str.split(",")]
            except Exception:
                pass

        event_data = None
        if not box_coords and not polygon_arg:
            if event_id:
                try:
                    async with session.get(f"{base_url}/api/events/{event_id}", timeout=10) as resp:
                        if resp.status == 200:
                            event_data = await resp.json()
                            box_coords = event_data.get("data", {}).get("box")
                            if not camera:
                                camera = event_data.get("camera", "wyze_camera")
                            if not label_val:
                                label_val = event_data.get("label", "")
                except Exception as e:
                    _LOGGER.error("Error fetching Frigate event %s: %s", event_id, e)
            else:
                # Fallback: find the most recent event for camera if event_id was not passed
                try:
                    cam_param = f"?camera={camera}&limit=5" if camera else "?limit=5"
                    async with session.get(f"{base_url}/api/events{cam_param}", timeout=10) as resp:
                        if resp.status == 200:
                            evts = await resp.json()
                            if isinstance(evts, list) and len(evts) > 0:
                                event_data = evts[0]
                                event_id = event_data.get("id", "")
                                box_coords = event_data.get("data", {}).get("box")
                                if not camera:
                                    camera = event_data.get("camera", "wyze_camera")
                                if not label_val:
                                    label_val = event_data.get("label", "")
                                if not mask_id or mask_id == "manual":
                                    mask_id = event_id.split("-")[0] if "-" in event_id else event_id or "manual"
                                _LOGGER.info("Using latest Frigate event fallback %s for camera %s", event_id, camera)
                except Exception as e:
                    _LOGGER.error("Error fetching latest Frigate events: %s", e)

        poly_str = polygon_arg
        if not box_coords and not poly_str:
            # Check if mask_id already exists in active_masks to reuse polygon, camera, and label
            if mask_id in domain_data["active_masks"]:
                existing = domain_data["active_masks"][mask_id]
                poly_str = existing.get("polygon", "")
                if not camera or camera == "wyze_camera":
                    camera = existing.get("camera", camera)
                if not label_val:
                    label_val = existing.get("label", "")
                if not box_coords:
                    box_coords = existing.get("box")

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
        if not label_val and event_data and isinstance(event_data, dict):
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
                    label_pattern = rf"^{f_indent}  {re.escape(obj_label)}:\s*(?:{{}}\s*)?$"
                    l_match = re.search(label_pattern, cleaned, re.MULTILINE)
                    if l_match:
                        matched_line = l_match.group(0)
                        if "{}" in matched_line:
                            label_indent = f_indent + "  "
                            mask_indent = label_indent + "  "
                            item_indent = mask_indent
                            replacement = f"{label_indent}{obj_label}:\n{mask_indent}mask:\n{item_indent}- {polygon} {mask_tag}"
                            return cleaned[:l_match.start()] + replacement + cleaned[l_match.end():]

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

        # Check if the mask is already active and config is unchanged (duration-only update)
        existing_mask = domain_data["active_masks"].get(mask_id)
        tag_already_in_config = tag in raw_config
        is_same_geometry = existing_mask and existing_mask.get("polygon") == poly_str
        is_config_identical = updated_config.strip() == raw_config.strip()
        is_pending_restart = mask_id in domain_data["pending_restart_masks"]

        is_duration_only = tag_already_in_config and not is_pending_restart and (is_same_geometry or is_config_identical)

        if is_duration_only:
            _LOGGER.info(
                "Temporary mask %s is already active in Frigate config. Updated duration to %s hours without Frigate restart.",
                mask_id,
                duration_hours
            )
        else:
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
                    domain_data["pending_restart_masks"].clear()
            except Exception as e:
                _LOGGER.error("Failed to save Frigate config: %s", e)
                return

        # Cancel any previous timer for this mask
        if mask_id in domain_data["timers"]:
            domain_data["timers"][mask_id]()

        # Record active mask metadata
        expires_at = datetime.now(timezone.utc) + timedelta(hours=duration_hours)
        
        # Remove from pending if re-adding
        domain_data["pending_restart_masks"].pop(mask_id, None)

        domain_data["active_masks"][mask_id] = {
            "mask_id": mask_id,
            "camera": camera,
            "polygon": poly_str,
            "duration_hours": duration_hours,
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
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
        domain_data["timers"][mask_id] = unsub

        _LOGGER.info("Added temporary mask %s for %s (%s hours)", mask_id, camera, duration_hours)

    async def async_handle_remove_mask(call: ServiceCall):
        mask_id = call.data.get("mask_id")
        if not mask_id:
            return

        # Cancel expiration timer
        if mask_id in domain_data["timers"]:
            domain_data["timers"][mask_id]()
            del domain_data["timers"][mask_id]

        if mask_id in domain_data["active_masks"]:
            removed_mask = dict(domain_data["active_masks"].pop(mask_id))
            removed_mask["removed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            domain_data["pending_restart_masks"][mask_id] = removed_mask
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
        for unsub in domain_data["timers"].values():
            unsub()
        domain_data["timers"].clear()

        for m_id, m_val in domain_data["active_masks"].items():
            removed_mask = dict(m_val)
            removed_mask["removed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            domain_data["pending_restart_masks"][m_id] = removed_mask
        domain_data["active_masks"].clear()
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
                domain_data["pending_restart_masks"].clear()
                _update_state()
        except Exception as e:
            _LOGGER.error("Failed to restart Frigate: %s", e)

    async def async_handle_sync(call: ServiceCall):
        _LOGGER.debug("Manual sync of temporary masks triggered")
        await _async_sync_frigate_state()

    async def async_handle_dismiss_pending(call: ServiceCall):
        mask_id = call.data.get("mask_id")
        if mask_id:
            domain_data["pending_restart_masks"].pop(str(mask_id), None)
            _LOGGER.info("Dismissed pending restart mask %s", mask_id)
        else:
            domain_data["pending_restart_masks"].clear()
            _LOGGER.info("Dismissed all pending restart masks")
        _update_state()

    if not domain_data.get("services_registered"):
        hass.services.async_register(DOMAIN, "add_mask", async_handle_add_mask)
        hass.services.async_register(DOMAIN, "set_duration", async_handle_add_mask)
        hass.services.async_register(DOMAIN, "remove_mask", async_handle_remove_mask)
        hass.services.async_register(DOMAIN, "prune_all", async_handle_prune_all)
        hass.services.async_register(DOMAIN, "restart", async_handle_restart)
        hass.services.async_register(DOMAIN, "restart_frigate", async_handle_restart)
        hass.services.async_register(DOMAIN, "sync", async_handle_sync)
        hass.services.async_register(DOMAIN, "dismiss_pending", async_handle_dismiss_pending)
        domain_data["services_registered"] = True

    # Periodic background synchronization
    if not domain_data.get("unsub_sync"):
        async def _periodic_sync_cb(_now):
            await _async_sync_frigate_state()
        domain_data["unsub_sync"] = async_track_time_interval(
            hass, _periodic_sync_cb, timedelta(seconds=SYNC_INTERVAL_SECONDS)
        )

    # Initial state update & background sync with running Frigate process
    _update_state()
    hass.async_create_task(_async_sync_frigate_state())

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
    if DOMAIN in hass.data:
        unsub = hass.data[DOMAIN].get("unsub_sync")
        if unsub:
            unsub()
            hass.data[DOMAIN]["unsub_sync"] = None
        for timer_unsub in hass.data[DOMAIN].get("timers", {}).values():
            timer_unsub()
        hass.data[DOMAIN]["timers"].clear()
    return True
