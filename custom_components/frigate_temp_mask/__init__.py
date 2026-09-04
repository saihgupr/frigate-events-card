"""Frigate Temporary False-Positive Mask Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import re
try:
    import yaml
except ImportError:
    yaml = None
from datetime import datetime, timedelta, timezone

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.typing import ConfigType

DOMAIN = "frigate_temp_mask"
_LOGGER = logging.getLogger(__name__)

DEFAULT_FRIGATE_URL = "http://192.168.1.211:5000"
DEFAULT_PADDING = 0.10
SYNC_INTERVAL_SECONDS = 30


def _coerce_frigate_box(value: object) -> list[float] | None:
    """Return a valid Frigate API box: [x, y, width, height]."""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None

    try:
        box = [float(coordinate) for coordinate in value]
    except (TypeError, ValueError):
        return None

    if not all(coordinate == coordinate and abs(coordinate) != float("inf") for coordinate in box):
        return None

    return box


def _get_event_box(event_data: object) -> list[float] | None:
    """Get the snapshot bounding box from a Frigate event response."""
    if not isinstance(event_data, dict):
        return None

    data = event_data.get("data")
    if isinstance(data, dict):
        # data.box is the box used for the event snapshot. It is [x, y, width,
        # height], normalized to the detection frame. Prefer it so the generated
        # mask matches the false detection the user selected.
        for candidate in (data.get("box"), (data.get("snapshot") or {}).get("box") if isinstance(data.get("snapshot"), dict) else None):
            box = _coerce_frigate_box(candidate)
            if box:
                return box

    return _coerce_frigate_box(event_data.get("box"))


class FrigateRecordingSnapshotView(HomeAssistantView):
    """View to proxy uncropped recording snapshot frames from Frigate."""

    url = "/api/frigate_temp_mask/recording_snapshot/{camera}/{timestamp:[.0-9]+}"
    extra_urls = ["/api/frigate_temp_mask/recording_snapshot/{camera}"]
    name = "api:frigate_temp_mask:recording_snapshot"
    requires_auth = False

    def __init__(self, hass: HomeAssistant, get_base_url_fn) -> None:
        self.hass = hass
        self._get_base_url = get_base_url_fn

    async def get(self, request: web.Request, camera: str, timestamp: str = "") -> web.Response:
        session = async_get_clientsession(self.hass)
        base_url = self._get_base_url()
        ts = timestamp or request.query.get("ts", "")
        if ts:
            clean_ts = ts.split(".")[0]
            frigate_url = f"{base_url}/api/{camera}/recordings/{clean_ts}/snapshot.png"
            try:
                async with session.get(frigate_url, timeout=10) as resp:
                    if resp.status == 200:
                        data = await resp.read()
                        return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
            except Exception as e:
                _LOGGER.debug("Error fetching recording snapshot from Frigate: %s", e)

        # Fallback to latest camera detect frame
        try:
            latest_url = f"{base_url}/api/{camera}/latest.jpg"
            async with session.get(latest_url, timeout=10) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "public, max-age=60"})
        except Exception as e:
            _LOGGER.error("Error fetching latest camera snapshot for %s: %s", camera, e)

        return web.Response(status=404)


class FrigateEventDeleteView(HomeAssistantView):
    """View to proxy DELETE event requests to Frigate."""

    url = "/api/frigate_temp_mask/events/{event_id}"
    name = "api:frigate_temp_mask:event_delete"
    requires_auth = False

    def __init__(self, hass: HomeAssistant, get_base_url_fn) -> None:
        self.hass = hass
        self._get_base_url = get_base_url_fn

    async def delete(self, request: web.Request, event_id: str) -> web.Response:
        session = async_get_clientsession(self.hass)
        base_url = self._get_base_url()
        try:
            async with session.delete(f"{base_url}/api/events/{event_id}", timeout=10) as resp:
                if resp.status in (200, 204):
                    return web.json_response({"success": True, "event_id": event_id})
                return web.json_response(
                    {"success": False, "error": f"Frigate returned status {resp.status}"},
                    status=resp.status,
                )
        except Exception as e:
            _LOGGER.error("Error deleting Frigate event %s: %s", event_id, e)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    async def post(self, request: web.Request, event_id: str) -> web.Response:
        """Allow POST as an alternate method for environments blocking DELETE."""
        return await self.delete(request, event_id)


def _parse_iso_to_timestamp(iso_str: str | None) -> float | None:
    """Parse ISO formatted timestamp string to float epoch seconds."""
    if not iso_str:
        return None
    try:
        clean_str = iso_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean_str).timestamp()
    except Exception:
        return None


def _polygon_to_box(poly_str: str) -> list[float] | None:
    """Derive bounding box [x, y, w, h] from polygon coordinate string."""
    if not poly_str:
        return None
    try:
        parts = [float(p.strip()) for p in str(poly_str).split(",") if p.strip()]
        if len(parts) >= 4 and len(parts) % 2 == 0:
            xs = [parts[i] for i in range(0, len(parts), 2)]
            ys = [parts[i + 1] for i in range(0, len(parts), 2)]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            w = max_x - min_x
            h = max_y - min_y
            return [min_x, min_y, w, h]
    except Exception:
        pass
    return None


def _parse_mask_timestamp(mask_id: str) -> float | None:
    """Extract unix timestamp from mask_id if available."""
    parts = str(mask_id).split("-")[0]
    try:
        ts = float(parts)
        if 1577836800 <= ts <= 4102444800:
            return ts
    except (ValueError, TypeError):
        pass
    m = re.search(r"(\d{10}(?:\.\d+)?)", str(mask_id))
    if m:
        try:
            ts = float(m.group(1))
            if 1577836800 <= ts <= 4102444800:
                return ts
        except (ValueError, TypeError):
            pass
    return None


def _parse_temp_masks_from_config(config_text: str) -> list[dict[str, str]]:
    """Scan Frigate raw YAML configuration for # TEMP_MASK_<id> entries."""
    masks: list[dict[str, str]] = []
    lines = config_text.splitlines()
    stack: list[dict[str, any]] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        indent = len(line) - len(line.lstrip(" "))

        while stack and stack[-1]["indent"] >= indent:
            stack.pop()

        if stripped.startswith("-") and "TEMP_MASK_" in stripped:
            m = re.search(r"-\s*([0-9.,\s]+?)\s*#\s*TEMP_MASK_(\S+)", stripped)
            if m:
                polygon = m.group(1).strip()
                mask_id = m.group(2).strip()

                camera = ""
                label = ""

                for item in stack:
                    ctx = item.get("context")
                    if ctx == "camera":
                        camera = item["key"]
                    elif ctx == "filter_label":
                        label = item["key"]

                masks.append({
                    "mask_id": mask_id,
                    "polygon": polygon,
                    "camera": camera,
                    "label": label,
                })
            continue

        colon_idx = stripped.find(":")
        if colon_idx != -1:
            key = stripped[:colon_idx].strip()
            parent_context = stack[-1]["context"] if stack else "root"
            context = "other"

            if parent_context == "root" and key == "cameras":
                context = "cameras"
            elif parent_context == "cameras":
                context = "camera"
            elif key == "filters":
                context = "filters"
            elif parent_context == "filters":
                context = "filter_label"
            elif key == "objects":
                context = "objects"
            elif key == "mask":
                context = "mask"

            stack.append({
                "indent": indent,
                "key": key,
                "context": context,
            })

    return masks



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
        box = _coerce_frigate_box(box)
        if not box or width <= 0 or height <= 0:
            return ""
        # Frigate's event API uses [x, y, width, height]. The last two values
        # are dimensions, not bottom-right coordinates.
        x_val, y_val, box_width_val, box_height_val = box
        if box_width_val <= 0 or box_height_val <= 0:
            return ""

        # Detect if values are normalized (0.0 to 1.0) or already in pixels
        is_normalized = all(0.0 <= v <= 1.0 for v in box)
        scale_x = width if is_normalized else 1.0
        scale_y = height if is_normalized else 1.0

        x1_px = x_val * scale_x
        y1_px = y_val * scale_y
        x2_px = (x_val + box_width_val) * scale_x
        y2_px = (y_val + box_height_val) * scale_y

        w = max(1.0, x2_px - x1_px)
        h = max(1.0, y2_px - y1_px)
        pad_x = w * padding
        pad_y_top = h * padding
        pad_y_bottom = h * padding

        x_min = max(0, int(round(min(x1_px, x2_px) - pad_x)))
        y_min = max(0, int(round(min(y1_px, y2_px) - pad_y_top)))
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
                # Do NOT auto-prune adopted orphan masks whose creation was in the past;
                # they remain visible in the UI with 'Expired' badge until user removes or extends them!
                if mask_data.get("is_orphan"):
                    continue
                exp_str = mask_data.get("expires_at")
                exp_ts = _parse_iso_to_timestamp(exp_str)
                if exp_ts is not None and exp_ts <= now_ts:
                    expired_ids.append(mask_id)

            for mask_id in expired_ids:
                _LOGGER.info("Active mask %s expired during sync check, pruning...", mask_id)
                await async_handle_remove_mask(ServiceCall(DOMAIN, "remove_mask", {"mask_id": mask_id}))

        # 3. Reconcile active configuration from Frigate raw config
        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as cfg_resp:
                if cfg_resp.status == 200:
                    raw_config_text = await cfg_resp.text()
                    discovered_masks = _parse_temp_masks_from_config(raw_config_text)
                    discovered_by_id = {m["mask_id"]: m for m in discovered_masks}
                    now_dt = datetime.now(timezone.utc)
                    now_ts = now_dt.timestamp()

                    # 3a. Remove tracked masks that are no longer present in Frigate config
                    for tracked_id in list(active.keys()):
                        if tracked_id not in discovered_by_id:
                            _LOGGER.info(
                                "Mask %s no longer present in Frigate raw config, removing from active masks.",
                                tracked_id,
                            )
                            if tracked_id in domain_data["timers"]:
                                domain_data["timers"][tracked_id]()
                                del domain_data["timers"][tracked_id]
                            active.pop(tracked_id, None)

                    # 3b. Process discovered masks from config
                    for disc_id, disc_data in discovered_by_id.items():
                        poly_str = disc_data.get("polygon", "")
                        label_val = disc_data.get("label", "")
                        cam_name = disc_data.get("camera", "")
                        creation_ts = _parse_mask_timestamp(disc_id)

                        if disc_id in active:
                            # Already tracked in memory: update camera/label if missing
                            existing = active[disc_id]
                            if not existing.get("camera") and cam_name:
                                existing["camera"] = cam_name
                            if not existing.get("label") and label_val:
                                existing["label"] = label_val
                            if not existing.get("polygon") and poly_str:
                                existing["polygon"] = poly_str
                            continue

                        # Discovered mask not yet tracked in active_masks
                        # Adopt ANY temporary mask found in Frigate config into HA so the user sees it
                        # and can manage/remove/extend it from the card popup.
                        is_orphan = False
                        if creation_ts is not None:
                            created_dt = datetime.fromtimestamp(creation_ts, timezone.utc)
                            expires_dt = created_dt + timedelta(hours=24)
                            remaining_seconds = expires_dt.timestamp() - now_ts
                            duration_hrs = 24.0
                            if remaining_seconds <= 0:
                                # Mask creation is older than 24h: adopt as orphan with expired timestamp
                                # so it displays as 'Expired' in the UI with full remove/extend controls.
                                is_orphan = True
                                remaining_seconds = 0
                        else:
                            duration_hrs = 24.0
                            expires_dt = now_dt + timedelta(hours=duration_hrs)
                            remaining_seconds = duration_hrs * 3600.0

                        # Adopt orphan mask
                        box_coords = _polygon_to_box(poly_str)
                        adopted_mask = {
                            "mask_id": disc_id,
                            "camera": cam_name or "wyze_camera",
                            "polygon": poly_str,
                            "duration_hours": duration_hrs,
                            "expires_at": expires_dt.isoformat().replace("+00:00", "Z"),
                            "event_id": disc_id,
                            "label": label_val or "car",
                            "box": box_coords,
                            "width": 1920,
                            "height": 1080,
                            "is_orphan": is_orphan,
                        }
                        active[disc_id] = adopted_mask
                        domain_data["pending_restart_masks"].pop(disc_id, None)

                        # Only schedule timer if not already an expired orphan
                        if not is_orphan and remaining_seconds > 0:
                            def _make_expire_cb(m_id, dur_h):
                                async def _expire_callback(_now):
                                    _LOGGER.info(
                                        "Adopted temporary mask %s expired after %s hours, pruning...",
                                        m_id,
                                        dur_h,
                                    )
                                    await async_handle_remove_mask(ServiceCall(DOMAIN, "remove_mask", {"mask_id": m_id}))
                                return _expire_callback

                            if disc_id in domain_data["timers"]:
                                domain_data["timers"][disc_id]()
                            domain_data["timers"][disc_id] = async_call_later(
                                hass,
                                max(1, int(remaining_seconds)),
                                _make_expire_cb(disc_id, duration_hrs),
                            )

                        _LOGGER.info(
                            "Adopted orphan temporary mask %s (camera: '%s', label: '%s', expired: %s)",
                            disc_id,
                            cam_name or "wyze_camera",
                            label_val or "car",
                            is_orphan,
                        )

                    _update_state()
        except Exception as e:
            _LOGGER.warning("Error reconciling Frigate temporary masks from config: %s", e)

    async def async_handle_add_mask(call: ServiceCall):
        camera = (call.data.get("camera") or "").strip()
        raw_event_id = call.data.get("event_id")
        event_id = str(raw_event_id).strip().strip("\"'") if raw_event_id is not None else ""
        raw_mask_id = call.data.get("mask_id")
        mask_id = str(raw_mask_id).strip().strip("\"'") if raw_mask_id else ""
        if not mask_id:
            mask_id = event_id.split("-")[0] if "-" in event_id else event_id or "manual"
        box_str = call.data.get("box", "")
        try:
            duration_hours = float(call.data.get("duration_hours", 24))
        except (ValueError, TypeError):
            duration_hours = 24.0
        try:
            padding = float(call.data.get("padding", DEFAULT_PADDING))
        except (ValueError, TypeError):
            padding = DEFAULT_PADDING
        padding = max(0.0, padding)
        label_val = (call.data.get("label") or "").strip()

        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()

        polygon_arg = call.data.get("polygon", "")
        box_coords = None
        if box_str and str(box_str).strip().lower() not in ["", "none", "unknown"]:
            try:
                box_coords = _coerce_frigate_box([v.strip() for v in str(box_str).split(",")])
                if not box_coords:
                    _LOGGER.warning("Could not parse bounding box from string: '%s'", box_str)
            except Exception as e:
                _LOGGER.warning("Error parsing bounding box '%s': %s", box_str, e)

        event_data = None
        if not box_coords and not polygon_arg:
            if event_id:
                try:
                    async with session.get(f"{base_url}/api/events/{event_id}", timeout=10) as resp:
                        if resp.status == 200:
                            event_data = await resp.json()
                            box_coords = _get_event_box(event_data)
                            if not box_coords:
                                _LOGGER.error("Frigate event %s found, but no valid bounding box was present in event data: %s", event_id, event_data)
                            if not camera:
                                camera = event_data.get("camera", "")
                            if not label_val:
                                label_val = event_data.get("label", "")
                        else:
                            _LOGGER.error("Frigate event API returned status %s for event_id '%s' at %s/api/events/%s", resp.status, event_id, base_url, event_id)
                except Exception as e:
                    _LOGGER.error("Error fetching Frigate event %s from %s: %s", event_id, base_url, e)
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
                                box_coords = _get_event_box(event_data)
                                if not camera:
                                    camera = event_data.get("camera", "")
                                if not label_val:
                                    label_val = event_data.get("label", "")
                                if not mask_id or mask_id == "manual":
                                    mask_id = event_id.split("-")[0] if "-" in event_id else event_id or "manual"
                                _LOGGER.info("Using latest Frigate event fallback %s for camera %s", event_id, camera or "unknown")
                            else:
                                _LOGGER.warning("No recent Frigate events found for event fallback (camera=%s)", camera or "all")
                        else:
                            _LOGGER.error("Frigate events query returned status %s for fallback search", resp.status)
                except Exception as e:
                    _LOGGER.error("Error fetching latest Frigate events fallback: %s", e)

        poly_str = polygon_arg
        if not box_coords and not poly_str:
            # Check if mask_id already exists in active_masks to reuse polygon, camera, and label
            if mask_id in domain_data["active_masks"]:
                existing = domain_data["active_masks"][mask_id]
                poly_str = existing.get("polygon", "")
                if not camera:
                    camera = existing.get("camera", "")
                if not label_val:
                    label_val = existing.get("label", "")
                if not box_coords:
                    box_coords = existing.get("box")

        if not box_coords and not poly_str:
            _LOGGER.error(
                "No valid bounding box, polygon, or event ID could be resolved to add a temporary mask (event_id='%s', camera='%s', mask_id='%s')",
                event_id,
                camera,
                mask_id,
            )
            return

        if not camera:
            camera = "wyze_camera"
            _LOGGER.warning("No camera specified or inferred from event; falling back to default camera '%s'", camera)

        width, height = 1920, 1080
        if not poly_str:
            # Fetch camera detect stream resolution
            try:
                async with session.get(f"{base_url}/api/config", timeout=10) as resp:
                    if resp.status == 200:
                        cfg = await resp.json()
                        detect_cfg = cfg.get("cameras", {}).get(camera, {}).get("detect", {})
                        width = detect_cfg.get("width", 1920)
                        height = detect_cfg.get("height", 1080)
            except Exception as e:
                _LOGGER.warning("Using fallback resolution 1920x1080 for camera %s: %s", camera, e)

            poly_str = _box_to_polygon(box_coords, width, height, padding)
            if not poly_str:
                _LOGGER.error("Could not create a temporary mask from invalid box data: %s", box_coords)
                return
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
            "width": width,
            "height": height,
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
        raw_mask_id = call.data.get("mask_id")
        mask_id = str(raw_mask_id).strip().strip("\"'") if raw_mask_id is not None else ""
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
                    _LOGGER.error("Failed to fetch Frigate raw config during remove_mask (status: %s)", resp.status)
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
                if save_resp.status == 200:
                    _LOGGER.info("Removed temporary mask %s (saved to config without restart)", mask_id)
                else:
                    _LOGGER.error("Failed to save Frigate config during remove_mask (status: %s)", save_resp.status)
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

    async def async_handle_delete_event(call: ServiceCall):
        event_id = call.data.get("event_id")
        if not event_id:
            _LOGGER.error("No event_id provided for delete_event")
            return
        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()
        try:
            async with session.delete(f"{base_url}/api/events/{event_id}", timeout=10) as resp:
                if resp.status in (200, 204):
                    _LOGGER.info("Deleted Frigate event %s", event_id)
                else:
                    _LOGGER.error("Failed to delete Frigate event %s (status: %s)", event_id, resp.status)
        except Exception as e:
            _LOGGER.error("Failed to delete Frigate event %s: %s", event_id, e)

    hass.services.async_register(DOMAIN, "add_mask", async_handle_add_mask)
    hass.services.async_register(DOMAIN, "set_duration", async_handle_add_mask)
    hass.services.async_register(DOMAIN, "remove_mask", async_handle_remove_mask)
    hass.services.async_register(DOMAIN, "prune_all", async_handle_prune_all)
    hass.services.async_register(DOMAIN, "restart", async_handle_restart)
    hass.services.async_register(DOMAIN, "restart_frigate", async_handle_restart)
    hass.services.async_register(DOMAIN, "sync", async_handle_sync)
    hass.services.async_register(DOMAIN, "dismiss_pending", async_handle_dismiss_pending)
    hass.services.async_register(DOMAIN, "delete_event", async_handle_delete_event)
    domain_data["services_registered"] = True

    if not domain_data.get("view_registered"):
        try:
            hass.http.register_view(FrigateRecordingSnapshotView(hass, _get_frigate_base_url))
        except Exception:
            pass
        try:
            hass.http.register_view(FrigateEventDeleteView(hass, _get_frigate_base_url))
        except Exception:
            pass
        domain_data["view_registered"] = True

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
