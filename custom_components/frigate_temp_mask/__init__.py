"""Frigate Temporary False-Positive Mask Integration for Home Assistant."""
from __future__ import annotations

import logging
import asyncio
import re
import json
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
CONFIG_AUDIT_INTERVAL_SECONDS = 600  # 10 minutes background audit safety net


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


def _parse_frigate_version(version_str: str) -> tuple[int, ...]:
    """Parse Frigate version string (e.g. '0.18-0', '0.14.1') into tuple of ints."""
    if not version_str:
        return (0, 0)
    v = version_str.lstrip("v").strip()
    parts = re.findall(r"\d+", v)
    if not parts:
        return (0, 0)
    return tuple(int(p) for p in parts)


def _box_to_polygon(box: list[float], width: int, height: int, padding: float = DEFAULT_PADDING, normalized: bool = True) -> str:
    """Convert bounding box [x, y, w, h] to 8-point polygon coordinate string."""
    box = _coerce_frigate_box(box)
    if not box or width <= 0 or height <= 0:
        return ""
    x_val, y_val, box_w, box_h = box
    if box_w <= 0 or box_h <= 0:
        return ""

    is_box_normalized = all(0.0 <= v <= 1.0 for v in box)
    if is_box_normalized:
        norm_x = x_val
        norm_y = y_val
        norm_w = box_w
        norm_h = box_h
    else:
        norm_x = x_val / width
        norm_y = y_val / height
        norm_w = box_w / width
        norm_h = box_h / height

    pad_x = norm_w * padding
    pad_y = norm_h * padding

    x_min = max(0.0, min(1.0, norm_x - pad_x))
    y_min = max(0.0, min(1.0, norm_y - pad_y))
    x_max = max(0.0, min(1.0, norm_x + norm_w + pad_x))
    y_max = max(0.0, min(1.0, norm_y + norm_h + pad_y))

    if normalized:
        x_min_r = round(x_min, 3)
        y_min_r = round(y_min, 3)
        x_max_r = round(x_max, 3)
        y_max_r = round(y_max, 3)
        return f"{x_min_r},{y_min_r},{x_max_r},{y_min_r},{x_max_r},{y_max_r},{x_min_r},{y_max_r}"
    else:
        px_min = max(0, int(round(x_min * width)))
        py_min = max(0, int(round(y_min * height)))
        px_max = min(width, int(round(x_max * width)))
        py_max = min(height, int(round(y_max * height)))
        return f"{px_min},{py_min},{px_max},{py_min},{px_max},{py_max},{px_min},{py_max}"



def _normalize_raw_config(text: str) -> str:
    """Normalize raw config text.

    Frigate 0.18+ (FastAPI) returns /api/config/raw as a JSON-encoded string literal
    containing escaped newlines (e.g. "mqtt:\\n  enabled: true...").
    Earlier Frigate versions return plain text. This helper unescapes JSON strings when present.
    """
    if not text:
        return ""
    text_stripped = text.strip()
    if (text_stripped.startswith('"') and text_stripped.endswith('"')) or (text_stripped.startswith("'") and text_stripped.endswith("'")):
        try:
            return json.loads(text_stripped)
        except Exception:
            pass
    return text


def _detect_config_version_and_format(config_text: str, camera: str = "", version_str: str = "") -> tuple[tuple[int, ...], bool]:
    """Detect Frigate version and whether to use dictionary-style masks.
    
    Returns (version_tuple, is_dict).
    """
    config_text = _normalize_raw_config(config_text)
    if not version_str:
        m = re.search(r"^version:\s*['\"]?([0-9a-zA-Z._-]+)['\"]?", config_text, re.MULTILINE)
        if m:
            version_str = m.group(1).strip()

    version_tuple = _parse_frigate_version(version_str) if version_str else (0, 18, 0)

    # Frigate 0.18+ always uses dict format
    if version_tuple >= (0, 18):
        return version_tuple, True

    # Check if target camera or any camera already uses dictionary-style masks
    # (has lines with "coordinates:" under "mask:")
    lines = config_text.splitlines()
    in_camera = not camera
    in_mask = False
    mask_indent = -1
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if stripped.endswith(":") and not stripped.startswith("-"):
            key = stripped[:-1].strip()
            if key == "cameras":
                continue
            if camera and key == camera and indent == 2:
                in_camera = True
                continue
            elif in_camera and camera and indent <= 2 and key != camera:
                in_camera = False
                continue
            if in_camera and key == "mask":
                in_mask = True
                mask_indent = indent
                continue
            elif in_mask and indent <= mask_indent:
                in_mask = False

        if in_camera and in_mask:
            if stripped.startswith("coordinates:"):
                return version_tuple, True
            if stripped.startswith("-"):
                return version_tuple, False

    # Default based on version: 0.18+ dict, earlier list
    is_dict = version_tuple >= (0, 18)
    return version_tuple, is_dict


def _find_camera_block_bounds(lines: list[str], camera: str) -> tuple[int, int, int]:
    """Find start, end line index and indent of a specific camera under cameras:
    
    Returns (start_idx, end_idx, camera_indent).
    If camera not found, returns (-1, -1, -1).
    """
    in_cameras = False
    cameras_indent = -1
    camera_start = -1
    camera_indent = -1

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))

        if stripped == "cameras:" or stripped.startswith("cameras:"):
            in_cameras = True
            cameras_indent = indent
            continue

        if in_cameras:
            if indent <= cameras_indent:
                break
            if camera_start == -1:
                colon_idx = stripped.find(":")
                if colon_idx != -1:
                    key = stripped[:colon_idx].strip()
                    if key == camera:
                        camera_start = i
                        camera_indent = indent
                        continue
            else:
                if indent <= camera_indent:
                    return camera_start, i, camera_indent

    if camera_start != -1:
        return camera_start, len(lines), camera_indent

    return -1, -1, -1


def _clean_config_masks(config_text: str, mask_id_to_remove: str = "") -> str:
    """Remove temporary mask entries (both dictionary blocks and list items)."""
    config_text = _normalize_raw_config(config_text)
    target_tag = f"TEMP_MASK_{mask_id_to_remove}" if mask_id_to_remove else "TEMP_MASK_"
    target_key = f"temp_mask_{mask_id_to_remove}" if mask_id_to_remove else "temp_mask_"
    safe_key = f"temp_mask_{re.sub(r'[^a-zA-Z0-9_]', '_', mask_id_to_remove)}" if mask_id_to_remove else "temp_mask_"

    lines = config_text.splitlines()
    filtered: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))

        is_match = False
        if mask_id_to_remove:
            if target_tag in line or (
                stripped.startswith(f"{target_key}:")
                or stripped.startswith(f"{target_key} ")
                or stripped.startswith(f"{safe_key}:")
                or stripped.startswith(f"{safe_key} ")
            ):
                is_match = True
        else:
            if "TEMP_MASK_" in line or stripped.startswith("temp_mask_"):
                is_match = True

        if is_match:
            colon_idx = stripped.find(":")
            if colon_idx != -1 and not stripped.startswith("-"):
                i += 1
                while i < n:
                    next_line = lines[i]
                    if not next_line.strip():
                        j = i + 1
                        still_child = False
                        while j < n:
                            if lines[j].strip():
                                if len(lines[j]) - len(lines[j].lstrip(" ")) > indent:
                                    still_child = True
                                break
                            j += 1
                        if still_child:
                            i += 1
                            continue
                        else:
                            break
                    next_indent = len(next_line) - len(next_line.lstrip(" "))
                    if next_indent > indent:
                        i += 1
                    else:
                        break
                continue
            else:
                i += 1
                continue

        filtered.append(line)
        i += 1

    final_lines: list[str] = []
    for idx, l in enumerate(filtered):
        stripped = l.strip()
        if stripped == "mask:":
            indent = len(l) - len(l.lstrip(" "))
            has_child = False
            for next_l in filtered[idx + 1:]:
                if not next_l.strip() or next_l.strip().startswith("#"):
                    continue
                next_indent = len(next_l) - len(next_l.lstrip(" "))
                if next_indent > indent:
                    has_child = True
                break
            if not has_child:
                continue
        final_lines.append(l)

    return "\n".join(final_lines) + "\n"


def _parse_temp_masks_from_config(config_text: str) -> list[dict[str, str]]:
    """Scan Frigate raw YAML configuration for temp mask entries (dict and list formats)."""
    config_text = _normalize_raw_config(config_text)
    masks: list[dict[str, str]] = []
    lines = config_text.splitlines()
    stack: list[dict[str, any]] = []

    curr_dict_mask_id = ""
    curr_dict_indent = -1
    curr_coords_indent = -1

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        indent = len(line) - len(line.lstrip(" "))

        while stack and stack[-1]["indent"] >= indent:
            stack.pop()

        if curr_dict_mask_id and indent <= curr_dict_indent:
            curr_dict_mask_id = ""
            curr_dict_indent = -1
            curr_coords_indent = -1

        if curr_dict_mask_id:
            if stripped.startswith("coordinates:"):
                coords = stripped.split(":", 1)[1].strip().strip("\"'")
                if coords:
                    camera = ""
                    label = ""
                    for item in stack:
                        ctx = item.get("context")
                        if ctx == "camera":
                            camera = item["key"]
                        elif ctx == "filter_label":
                            label = item["key"]

                    masks.append({
                        "mask_id": curr_dict_mask_id,
                        "polygon": coords,
                        "camera": camera,
                        "label": label,
                    })
                    curr_dict_mask_id = ""
                    curr_dict_indent = -1
                    curr_coords_indent = -1
                    continue
                else:
                    curr_coords_indent = indent
                    continue
            elif curr_coords_indent != -1 and indent > curr_coords_indent:
                coords = stripped.strip("\"'")
                camera = ""
                label = ""
                for item in stack:
                    ctx = item.get("context")
                    if ctx == "camera":
                        camera = item["key"]
                    elif ctx == "filter_label":
                        label = item["key"]

                masks.append({
                    "mask_id": curr_dict_mask_id,
                    "polygon": coords,
                    "camera": camera,
                    "label": label,
                })
                curr_dict_mask_id = ""
                curr_dict_indent = -1
                curr_coords_indent = -1
                continue

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

            if parent_context == "mask":
                if "TEMP_MASK_" in stripped:
                    m = re.search(r"TEMP_MASK_(\S+)", stripped)
                    if m:
                        curr_dict_mask_id = m.group(1).strip().strip(":")
                        curr_dict_indent = indent
                elif key.startswith("temp_mask_"):
                    curr_dict_mask_id = key.removeprefix("temp_mask_").split("#")[0].strip()
                    curr_dict_indent = indent

            stack.append({
                "indent": indent,
                "key": key,
                "context": context,
            })

    return masks


def _inject_temp_mask(config_text: str, camera: str, polygon: str, mask_id: str, label: str = "", is_dict: bool = True) -> str:
    """Inject a temporary mask into the Frigate config text cleanly scoped to camera."""
    safe_mask_id = re.sub(r"[^a-zA-Z0-9_]", "_", mask_id)
    tag = f"TEMP_MASK_{mask_id}"
    cleaned = _clean_config_masks(config_text, mask_id)
    lines = cleaned.splitlines()

    obj_label = label.lower().strip() if label else ""
    if obj_label in ["people", "human", "persons"]:
        obj_label = "person"

    cam_start, cam_end, cam_indent = _find_camera_block_bounds(lines, camera)
    if cam_start == -1:
        cameras_idx = -1
        for i, l in enumerate(lines):
            if l.strip() == "cameras:" or l.strip().startswith("cameras:"):
                cameras_idx = i
                break
        if cameras_idx != -1:
            c_indent = "  "
            new_lines = [
                f"{c_indent}{camera}:",
                f"{c_indent}  objects:",
                f"{c_indent}    filters:",
                f"{c_indent}      {obj_label or 'car'}:",
                f"{c_indent}        mask:",
            ]
            if is_dict:
                friendly = f"Temporary Mask ({obj_label})" if obj_label else "Temporary Mask"
                new_lines.extend([
                    f"{c_indent}          temp_mask_{safe_mask_id}: # {tag}",
                    f"{c_indent}            friendly_name: \"{friendly}\"",
                    f"{c_indent}            enabled: true",
                    f"{c_indent}            coordinates: {polygon}",
                ])
            else:
                new_lines.append(f"{c_indent}          - {polygon} # {tag}")
            lines = lines[:cameras_idx + 1] + new_lines + lines[cameras_idx + 1:]
            return "\n".join(lines) + "\n"
        else:
            lines.append("objects:")
            lines.append("  mask:")
            if is_dict:
                lines.append(f"    temp_mask_{safe_mask_id}: # {tag}")
                lines.append("      friendly_name: \"Temporary Mask\"")
                lines.append("      enabled: true")
                lines.append(f"      coordinates: {polygon}")
            else:
                lines.append(f"    - {polygon} # {tag}")
            return "\n".join(lines) + "\n"

    cam_lines = lines[cam_start:cam_end]
    cam_ind_str = " " * cam_indent

    objects_rel_idx = -1
    objects_indent = -1
    for i, l in enumerate(cam_lines):
        if i == 0:
            continue
        stripped = l.strip()
        if not stripped or stripped.startswith("#"):
            continue
        ind = len(l) - len(l.lstrip(" "))
        if ind == cam_indent + 2:
            colon_idx = stripped.find(":")
            if colon_idx != -1 and stripped[:colon_idx].strip() == "objects":
                objects_rel_idx = i
                objects_indent = ind
                break

    if objects_rel_idx == -1:
        new_cam_lines = [
            f"{cam_ind_str}  objects:",
            f"{cam_ind_str}    filters:",
            f"{cam_ind_str}      {obj_label or 'car'}:",
            f"{cam_ind_str}        mask:",
        ]
        m_indent = cam_indent + 10
        if is_dict:
            friendly = f"Temporary Mask ({obj_label})" if obj_label else "Temporary Mask"
            new_cam_lines.extend([
                f"{' ' * m_indent}temp_mask_{mask_id}: # {tag}",
                f"{' ' * (m_indent + 2)}friendly_name: \"{friendly}\"",
                f"{' ' * (m_indent + 2)}enabled: true",
                f"{' ' * (m_indent + 2)}coordinates: \"{polygon}\"",
            ])
        else:
            new_cam_lines.append(f"{' ' * m_indent}- {polygon} # {tag}")

        lines = lines[:cam_start + 1] + new_cam_lines + lines[cam_start + 1:]
        return "\n".join(lines) + "\n"

    obj_abs_start = cam_start + objects_rel_idx
    obj_abs_end = cam_end
    for i in range(obj_abs_start + 1, cam_end):
        l = lines[i]
        stripped = l.strip()
        if not stripped or stripped.startswith("#"):
            continue
        ind = len(l) - len(l.lstrip(" "))
        if ind <= objects_indent:
            obj_abs_end = i
            break

    filters_abs_idx = -1
    filters_indent = -1
    obj_mask_abs_idx = -1
    obj_mask_indent = -1

    for i in range(obj_abs_start + 1, obj_abs_end):
        l = lines[i]
        stripped = l.strip()
        if not stripped or stripped.startswith("#"):
            continue
        ind = len(l) - len(l.lstrip(" "))
        if ind == objects_indent + 2:
            colon_idx = stripped.find(":")
            if colon_idx != -1:
                key = stripped[:colon_idx].strip()
                if key == "filters":
                    filters_abs_idx = i
                    filters_indent = ind
                elif key == "mask":
                    obj_mask_abs_idx = i
                    obj_mask_indent = ind

    target_label = obj_label
    if target_label and filters_abs_idx != -1:
        filt_end = obj_abs_end
        for i in range(filters_abs_idx + 1, obj_abs_end):
            l = lines[i]
            stripped = l.strip()
            if not stripped or stripped.startswith("#"):
                continue
            ind = len(l) - len(l.lstrip(" "))
            if ind <= filters_indent:
                filt_end = i
                break

        label_abs_idx = -1
        label_indent = -1
        for i in range(filters_abs_idx + 1, filt_end):
            l = lines[i]
            stripped = l.strip()
            if not stripped or stripped.startswith("#"):
                continue
            ind = len(l) - len(l.lstrip(" "))
            if ind == filters_indent + 2:
                colon_idx = stripped.find(":")
                if colon_idx != -1:
                    key = stripped[:colon_idx].strip()
                    if key == target_label:
                        label_abs_idx = i
                        label_indent = ind
                        break

        if label_abs_idx != -1:
            label_line = lines[label_abs_idx]
            stripped_label = label_line.strip()
            label_ind_str = " " * label_indent

            label_end = filt_end
            for i in range(label_abs_idx + 1, filt_end):
                l = lines[i]
                stripped = l.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                ind = len(l) - len(l.lstrip(" "))
                if ind <= label_indent:
                    label_end = i
                    break

            label_mask_idx = -1
            label_mask_indent = -1
            for i in range(label_abs_idx + 1, label_end):
                l = lines[i]
                stripped = l.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                ind = len(l) - len(l.lstrip(" "))
                if ind == label_indent + 2 and stripped.startswith("mask:"):
                    label_mask_idx = i
                    label_mask_indent = ind
                    break

            if label_mask_idx != -1:
                insert_idx = label_mask_idx + 1
                m_indent = label_mask_indent + 2
                if is_dict:
                    friendly = f"Temporary Mask ({target_label})"
                    to_insert = [
                        f"{' ' * m_indent}temp_mask_{safe_mask_id}: # {tag}",
                        f"{' ' * (m_indent + 2)}friendly_name: \"{friendly}\"",
                        f"{' ' * (m_indent + 2)}enabled: true",
                        f"{' ' * (m_indent + 2)}coordinates: {polygon}",
                    ]
                else:
                    to_insert = [f"{' ' * m_indent}- {polygon} # {tag}"]
                lines = lines[:insert_idx] + to_insert + lines[insert_idx:]
                return "\n".join(lines) + "\n"
            else:
                if "{}" in stripped_label:
                    lines[label_abs_idx] = f"{label_ind_str}{target_label}:"

                m_indent = label_indent + 2
                to_insert = [f"{' ' * m_indent}mask:"]
                if is_dict:
                    friendly = f"Temporary Mask ({target_label})"
                    to_insert.extend([
                        f"{' ' * (m_indent + 2)}temp_mask_{safe_mask_id}: # {tag}",
                        f"{' ' * (m_indent + 4)}friendly_name: \"{friendly}\"",
                        f"{' ' * (m_indent + 4)}enabled: true",
                        f"{' ' * (m_indent + 4)}coordinates: {polygon}",
                    ])
                else:
                    to_insert.append(f"{' ' * (m_indent + 2)}- {polygon} # {tag}")

                lines = lines[:label_abs_idx + 1] + to_insert + lines[label_abs_idx + 1:]
                return "\n".join(lines) + "\n"
        else:
            f_indent = filters_indent + 2
            to_insert = [
                f"{' ' * f_indent}{target_label}:",
                f"{' ' * (f_indent + 2)}mask:",
            ]
            if is_dict:
                friendly = f"Temporary Mask ({target_label})"
                to_insert.extend([
                    f"{' ' * (f_indent + 4)}temp_mask_{safe_mask_id}: # {tag}",
                    f"{' ' * (f_indent + 6)}friendly_name: \"{friendly}\"",
                    f"{' ' * (f_indent + 6)}enabled: true",
                    f"{' ' * (f_indent + 6)}coordinates: {polygon}",
                ])
            else:
                to_insert.append(f"{' ' * (f_indent + 4)}- {polygon} # {tag}")
            lines = lines[:filters_abs_idx + 1] + to_insert + lines[filters_abs_idx + 1:]
            return "\n".join(lines) + "\n"

    elif target_label and filters_abs_idx == -1:
        o_indent = objects_indent + 2
        to_insert = [
            f"{' ' * o_indent}filters:",
            f"{' ' * (o_indent + 2)}{target_label}:",
            f"{' ' * (o_indent + 4)}mask:",
        ]
        if is_dict:
            friendly = f"Temporary Mask ({target_label})"
            to_insert.extend([
                f"{' ' * (o_indent + 6)}temp_mask_{safe_mask_id}: # {tag}",
                f"{' ' * (o_indent + 8)}friendly_name: \"{friendly}\"",
                f"{' ' * (o_indent + 8)}enabled: true",
                f"{' ' * (o_indent + 8)}coordinates: {polygon}",
            ])
        else:
            to_insert.append(f"{' ' * (o_indent + 6)}- {polygon} # {tag}")
        lines = lines[:obj_abs_start + 1] + to_insert + lines[obj_abs_start + 1:]
        return "\n".join(lines) + "\n"

    else:
        if obj_mask_abs_idx != -1:
            m_indent = obj_mask_indent + 2
            if is_dict:
                friendly = "Temporary Mask"
                to_insert = [
                    f"{' ' * m_indent}temp_mask_{safe_mask_id}: # {tag}",
                    f"{' ' * (m_indent + 2)}friendly_name: \"{friendly}\"",
                    f"{' ' * (m_indent + 2)}enabled: true",
                    f"{' ' * (m_indent + 2)}coordinates: {polygon}",
                ]
            else:
                to_insert = [f"{' ' * m_indent}- {polygon} # {tag}"]
            lines = lines[:obj_mask_abs_idx + 1] + to_insert + lines[obj_mask_abs_idx + 1:]
            return "\n".join(lines) + "\n"
        else:
            o_indent = objects_indent + 2
            to_insert = [f"{' ' * o_indent}mask:"]
            if is_dict:
                friendly = "Temporary Mask"
                to_insert.extend([
                    f"{' ' * (o_indent + 2)}temp_mask_{safe_mask_id}: # {tag}",
                    f"{' ' * (o_indent + 4)}friendly_name: \"{friendly}\"",
                    f"{' ' * (o_indent + 4)}enabled: true",
                    f"{' ' * (o_indent + 4)}coordinates: {polygon}",
                ])
            else:
                to_insert.append(f"{' ' * (o_indent + 2)}- {polygon} # {tag}")
            lines = lines[:obj_abs_start + 1] + to_insert + lines[obj_abs_start + 1:]
            return "\n".join(lines) + "\n"



async def _async_setup_core(hass: HomeAssistant) -> bool:
    """Register services and initialize core data structures."""
    hass.data.setdefault(DOMAIN, {})
    domain_data = hass.data[DOMAIN]
    domain_data.setdefault("timers", {})
    domain_data.setdefault("active_masks", {})
    domain_data.setdefault("pending_restart_masks", {})
    domain_data.setdefault("services_registered", False)
    domain_data.setdefault("unsub_sync", None)
    domain_data.setdefault("last_config_audit_ts", 0.0)

    def _get_frigate_base_url() -> str:
        # Check if Frigate integration data is available
        if "frigate" in hass.data:
            frigate_entries = hass.config_entries.async_entries("frigate")
            for entry in frigate_entries:
                url = entry.data.get("url")
                if url:
                    return url.rstrip("/")
        return DEFAULT_FRIGATE_URL

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

    async def _async_sync_frigate_state(force_config_audit: bool = False) -> None:
        """Synchronize mask state with running Frigate process uptime and active config."""
        session = async_get_clientsession(hass)
        base_url = _get_frigate_base_url()
        now_dt = datetime.now(timezone.utc)
        now_ts = now_dt.timestamp()

        # 1. Prune pending restart masks if Frigate booted after the mask was removed
        pending = domain_data.get("pending_restart_masks", {})
        if pending:
            frigate_boot_ts: float | None = None
            try:
                async with session.get(f"{base_url}/api/stats", timeout=5) as resp:
                    if resp.status == 200:
                        stats = await resp.json()
                        service_info = stats.get("service", {})
                        uptime = service_info.get("uptime")
                        last_updated = service_info.get("last_updated")
                        if uptime is not None:
                            ref_time = float(last_updated) if last_updated else now_ts
                            frigate_boot_ts = ref_time - float(uptime)
            except Exception as e:
                _LOGGER.debug("Could not fetch Frigate stats for restart sync: %s", e)

            if frigate_boot_ts is not None:
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
        # Audited on-demand, on startup, and every 10 minutes in background
        should_audit = (
            force_config_audit
            or (now_ts - domain_data.get("last_config_audit_ts", 0.0) >= CONFIG_AUDIT_INTERVAL_SECONDS)
        )
        if not should_audit:
            return

        domain_data["last_config_audit_ts"] = now_ts
        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as cfg_resp:
                if cfg_resp.status == 200:
                    raw_config_text = _normalize_raw_config(await cfg_resp.text())
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

        # Fetch version (optional) and raw config
        version_str = ""
        try:
            async with session.get(f"{base_url}/api/version", timeout=5) as resp:
                if resp.status == 200:
                    version_str = (await resp.text()).strip().strip("\"'")
        except Exception:
            pass

        raw_config = ""
        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = _normalize_raw_config(await resp.text())
        except Exception as e:
            _LOGGER.error("Failed to read Frigate config: %s", e)
            return

        version_tuple, is_dict = _detect_config_version_and_format(raw_config, camera, version_str)
        use_normalized = version_tuple >= (0, 14) or is_dict

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

            poly_str = _box_to_polygon(box_coords, width, height, padding, normalized=use_normalized)
            if not poly_str:
                _LOGGER.error("Could not create a temporary mask from invalid box data: %s", box_coords)
                return

        tag = f"# TEMP_MASK_{mask_id}"
        if not label_val and event_data and isinstance(event_data, dict):
            label_val = event_data.get("label", "")

        updated_config = _inject_temp_mask(raw_config, camera, poly_str, mask_id, label_val, is_dict=is_dict)

        # Check if the mask is already active and config is unchanged (duration-only update)
        existing_mask = domain_data["active_masks"].get(mask_id)
        tag_already_in_config = tag in raw_config or f"temp_mask_{mask_id}" in raw_config
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
                # Frigate 0.18 requires ?save_option=query param; 'restart' saves and triggers restart
                async with session.post(
                    f"{base_url}/api/config/save?save_option=restart",
                    data=updated_config.encode("utf-8"),
                    headers={"Content-Type": "text/plain"},
                    timeout=15
                ) as resp:
                    resp.raise_for_status()

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
        dict_key = f"temp_mask_{mask_id}"

        try:
            async with session.get(f"{base_url}/api/config/raw", timeout=10) as resp:
                if resp.status == 200:
                    raw_config = _normalize_raw_config(await resp.text())
                else:
                    _LOGGER.error("Failed to fetch Frigate raw config during remove_mask (status: %s)", resp.status)
                    return

            if tag not in raw_config and dict_key not in raw_config:
                return

            updated_config = _clean_config_masks(raw_config, mask_id)

            # Save WITHOUT restart to avoid interrupting live video/detections
            async with session.post(
                f"{base_url}/api/config/save?save_option=none",
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
                    raw_config = _normalize_raw_config(await resp.text())
                else:
                    return

            if "TEMP_MASK_" not in raw_config and "temp_mask_" not in raw_config:
                return

            updated_config = _clean_config_masks(raw_config)

            async with session.post(
                f"{base_url}/api/config/save?save_option=none",
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
        await _async_sync_frigate_state(force_config_audit=True)

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
    hass.async_create_task(_async_sync_frigate_state(force_config_audit=True))

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
