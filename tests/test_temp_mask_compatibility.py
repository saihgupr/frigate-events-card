"""Comprehensive test suite for Frigate temporary mask version & config compatibility.
Imports functions directly from custom_components/frigate_temp_mask/__init__.py
"""

import os
import sys
import unittest
from unittest.mock import MagicMock

# Mock Home Assistant and aiohttp dependencies before import
sys.modules['homeassistant'] = MagicMock()
sys.modules['homeassistant.components'] = MagicMock()
sys.modules['homeassistant.components.http'] = MagicMock()
sys.modules['homeassistant.config_entries'] = MagicMock()
sys.modules['homeassistant.core'] = MagicMock()
sys.modules['homeassistant.helpers'] = MagicMock()
sys.modules['homeassistant.helpers.aiohttp_client'] = MagicMock()
sys.modules['homeassistant.helpers.event'] = MagicMock()
sys.modules['homeassistant.helpers.typing'] = MagicMock()
sys.modules['aiohttp'] = MagicMock()

# Ensure repository root is on sys.path
repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)

from custom_components.frigate_temp_mask import (
    _normalize_raw_config,
    _parse_frigate_version,
    _box_to_polygon,
    _detect_config_version_and_format,
    _find_camera_block_bounds,
    _clean_config_masks,
    _parse_temp_masks_from_config,
    _inject_temp_mask,
)


class TestFrigateMaskCompatibility(unittest.TestCase):

    def setUp(self):
        self.config_v18 = """
mqtt:
  enabled: true
  host: 192.168.1.199

cameras:
  wyze_camera:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/wyze_camera
          roles:
            - detect
            - record
    zones:
      front_a:
        coordinates: 0,0.375,0.58,0.425,0.592,1,0,1
    motion:
      mask:
        motion_mask_1:
          friendly_name: Motion Mask 1
          enabled: true
          coordinates: 0.45,0.002,0.388,0.235,0.573,0.255
    objects:
      filters:
        person: {}
        car:
          mask:
            object_mask_1:
              friendly_name: Object Mask 1 (car)
              enabled: true
              coordinates: 0,1,0.317,1,0.283,0.263,0,0.346
  back_camera:
    objects:
      filters:
        car: {}

version: 0.18-0
"""
        self.config_v14 = """
version: "0.14"
cameras:
  wyze_camera:
    objects:
      filters:
        car:
          mask:
            - 0.000,0.700,1.000,0.700,1.000,1.000,0.000,1.000
"""
        self.config_v13 = """
cameras:
  wyze_camera:
    objects:
      filters:
        car:
          mask:
            - 0,756,1920,756,1920,1080,0,1080
"""

    def test_version_parsing(self):
        self.assertEqual(_parse_frigate_version("0.18-0"), (0, 18, 0))
        self.assertEqual(_parse_frigate_version("0.14"), (0, 14))
        self.assertEqual(_parse_frigate_version("v0.15.1"), (0, 15, 1))
        self.assertTrue(_parse_frigate_version("0.18-0") >= (0, 18))
        self.assertTrue(_parse_frigate_version("0.14") >= (0, 14))
        self.assertFalse(_parse_frigate_version("0.13") >= (0, 14))

    def test_format_detection_v18(self):
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        self.assertEqual(v, (0, 18, 0))
        self.assertTrue(is_dict)

    def test_format_detection_v14(self):
        v, is_dict = _detect_config_version_and_format(self.config_v14, "wyze_camera")
        self.assertEqual(v, (0, 14))
        self.assertFalse(is_dict)

    def test_box_to_polygon_normalized(self):
        poly = _box_to_polygon([0.1, 0.2, 0.2, 0.2], 1920, 1080, padding=0.10, normalized=True)
        self.assertEqual(poly, "0.08,0.18,0.32,0.18,0.32,0.42,0.08,0.42")

    def test_box_to_polygon_pixels(self):
        poly = _box_to_polygon([0.1, 0.2, 0.2, 0.2], 1000, 1000, padding=0.10, normalized=False)
        self.assertEqual(poly, "80,180,320,180,320,420,80,420")

    def test_inject_v18_existing_car_mask(self):
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        poly = _box_to_polygon([0.2, 0.3, 0.1, 0.1], 1920, 1080, padding=0.10, normalized=True)
        updated = _inject_temp_mask(self.config_v18, "wyze_camera", poly, "test1234", label="car", is_dict=is_dict)
        
        self.assertIn("temp_mask_test1234:", updated)
        self.assertIn("friendly_name: \"Temporary Mask (car)\"", updated)
        self.assertIn("enabled: true", updated)
        self.assertIn(f"coordinates: {poly}", updated)
        self.assertNotIn("temp_mask_test1234", updated.split("back_camera:")[1])

        parsed = _parse_temp_masks_from_config(updated)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], "test1234")
        self.assertEqual(parsed[0]["camera"], "wyze_camera")
        self.assertEqual(parsed[0]["label"], "car")
        self.assertEqual(parsed[0]["polygon"], poly)

        cleaned = _clean_config_masks(updated, "test1234")
        self.assertNotIn("temp_mask_test1234", cleaned)
        self.assertIn("object_mask_1:", cleaned)

    def test_inject_v18_empty_person_filter(self):
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        poly = "0.05,0.05,0.15,0.05,0.15,0.25,0.05,0.25"
        updated = _inject_temp_mask(self.config_v18, "wyze_camera", poly, "person999", label="person", is_dict=is_dict)
        
        self.assertIn("person:\n", updated)
        self.assertIn("temp_mask_person999:", updated)
        
        parsed = _parse_temp_masks_from_config(updated)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], "person999")
        self.assertEqual(parsed[0]["label"], "person")
        self.assertEqual(parsed[0]["camera"], "wyze_camera")

        cleaned = _clean_config_masks(updated, "person999")
        self.assertNotIn("temp_mask_person999", cleaned)
        self.assertIn("person:", cleaned)

    def test_inject_v14_list_format(self):
        v, is_dict = _detect_config_version_and_format(self.config_v14, "wyze_camera")
        self.assertFalse(is_dict)
        poly = "0.1,0.2,0.3,0.2,0.3,0.4,0.1,0.4"
        updated = _inject_temp_mask(self.config_v14, "wyze_camera", poly, "v14mask", label="car", is_dict=is_dict)
        
        self.assertIn(f"- {poly} # TEMP_MASK_v14mask", updated)

        parsed = _parse_temp_masks_from_config(updated)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], "v14mask")
        self.assertEqual(parsed[0]["polygon"], poly)

        cleaned = _clean_config_masks(updated, "v14mask")
        self.assertNotIn("v14mask", cleaned)
        self.assertIn("0.000,0.700", cleaned)

    def test_inject_camera_no_objects_section(self):
        config = """
version: 0.18-0
cameras:
  porch:
    ffmpeg:
      inputs:
        - path: rtsp://localhost/porch
"""
        v, is_dict = _detect_config_version_and_format(config, "porch")
        self.assertTrue(is_dict)
        poly = "0.1,0.2,0.3,0.2,0.3,0.4,0.1,0.4"
        updated = _inject_temp_mask(config, "porch", poly, "porchmask", label="person", is_dict=is_dict)
        self.assertIn("porch:", updated)
        self.assertIn("objects:", updated)
        self.assertIn("filters:", updated)
        self.assertIn("person:", updated)
        self.assertIn("temp_mask_porchmask:", updated)

        parsed = _parse_temp_masks_from_config(updated)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], "porchmask")
        self.assertEqual(parsed[0]["camera"], "porch")
        self.assertEqual(parsed[0]["label"], "person")

    def test_prune_all_multiple_masks(self):
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        c1 = _inject_temp_mask(self.config_v18, "wyze_camera", "0.1,0.1,0.2,0.1,0.2,0.2,0.1,0.2", "m1", label="car", is_dict=is_dict)
        c2 = _inject_temp_mask(c1, "wyze_camera", "0.3,0.3,0.4,0.3,0.4,0.4,0.3,0.4", "m2", label="person", is_dict=is_dict)
        
        parsed = _parse_temp_masks_from_config(c2)
        self.assertEqual(len(parsed), 2)

        cleaned = _clean_config_masks(c2)
        self.assertNotIn("temp_mask_m1", cleaned)
        self.assertNotIn("temp_mask_m2", cleaned)
        self.assertIn("object_mask_1:", cleaned)
        self.assertEqual(len(_parse_temp_masks_from_config(cleaned)), 0)

    def test_normalize_raw_config_json_encoded(self):
        import json
        raw_yaml = "version: 0.18-0\nmqtt:\n  enabled: true\n"
        json_wrapped = json.dumps(raw_yaml)
        self.assertTrue(json_wrapped.startswith('"'))
        normalized = _normalize_raw_config(json_wrapped)
        self.assertEqual(normalized, raw_yaml)

    def test_inject_into_json_encoded_v18_config(self):
        import json
        json_wrapped = json.dumps(self.config_v18)
        # Should detect version and dict format even from json wrapped config
        v, is_dict = _detect_config_version_and_format(json_wrapped, "wyze_camera")
        self.assertEqual(v, (0, 18, 0))
        self.assertTrue(is_dict)

        poly = "0.1,0.1,0.2,0.1,0.2,0.2,0.1,0.2"
        updated = _inject_temp_mask(json_wrapped, "wyze_camera", poly, "jsonmask1", label="car", is_dict=is_dict)
        self.assertIn("temp_mask_jsonmask1:", updated)
        self.assertIn("coordinates: 0.1,0.1,0.2,0.1,0.2,0.2,0.1,0.2", updated)

        parsed = _parse_temp_masks_from_config(updated)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], "jsonmask1")
        self.assertEqual(parsed[0]["camera"], "wyze_camera")
        self.assertEqual(parsed[0]["label"], "car")

    def test_user_exact_config_person_and_car(self):
        user_cfg = """mqtt:
  enabled: true
  host: 192.168.1.199

cameras:
  wyze_camera:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/wyze_camera
    objects:
      filters:
        person: {}
        car:
          mask:
            object_mask_1:
              friendly_name: Object Mask 1 (car)
              enabled: true
              coordinates: 0,1,0.317,1,0.283,0.263,0,0.346
        umbrella: {}
      mask:
        object_mask_1:
          friendly_name: Object Mask 1
          enabled: true
          coordinates: 0,0.192,0.275,0.118,0.402,0,0,0
version: 0.18-0
"""
        import json
        # Wrap as JSON literal just like Frigate 0.18 API /api/config/raw returns
        user_cfg_json = json.dumps(user_cfg)
        
        v, is_dict = _detect_config_version_and_format(user_cfg_json, "wyze_camera")
        self.assertEqual(v, (0, 18, 0))
        self.assertTrue(is_dict)

        # Test injecting person mask where filter is person: {}
        c1 = _inject_temp_mask(user_cfg_json, "wyze_camera", "0.2,0.2,0.4,0.2,0.4,0.4,0.2,0.4", "pmask1", label="person", is_dict=is_dict)
        self.assertIn("person:", c1)
        self.assertIn("temp_mask_pmask1:", c1)

        # Test injecting car mask where car already has object_mask_1
        c2 = _inject_temp_mask(c1, "wyze_camera", "0.5,0.5,0.6,0.5,0.6,0.6,0.5,0.6", "cmask1", label="car", is_dict=is_dict)
        self.assertIn("object_mask_1:", c2)
        self.assertIn("temp_mask_cmask1:", c2)

        # Verify parsing both back
        parsed = _parse_temp_masks_from_config(c2)
        self.assertEqual(len(parsed), 2)
        by_id = {m["mask_id"]: m for m in parsed}
        self.assertEqual(by_id["pmask1"]["camera"], "wyze_camera")
        self.assertEqual(by_id["pmask1"]["label"], "person")
        self.assertEqual(by_id["cmask1"]["camera"], "wyze_camera")
        self.assertEqual(by_id["cmask1"]["label"], "car")

        # Verify cleaning
        cleaned = _clean_config_masks(c2, "pmask1")
        self.assertNotIn("temp_mask_pmask1", cleaned)
        self.assertIn("temp_mask_cmask1", cleaned)
        self.assertIn("Object Mask 1 (car)", cleaned)

    def test_decimal_dot_in_mask_id_sanitized(self):
        raw_id = "1789218715.393093"
        poly = "0.688,0.737,0.716,0.737,0.716,0.813,0.688,0.813"
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        injected = _inject_temp_mask(self.config_v18, "wyze_camera", poly, raw_id, label="person", is_dict=is_dict)
        # Dot should be sanitized in key name so Frigate pydantic validation passes
        self.assertIn("temp_mask_1789218715_393093:", injected)
        self.assertNotIn("temp_mask_1789218715.393093:", injected)
        self.assertIn(f"coordinates: {poly}", injected)

        # Parse should recover the mask
        parsed = _parse_temp_masks_from_config(injected)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["mask_id"], raw_id)

        # Clean should remove it using the raw_id
        cleaned = _clean_config_masks(injected, raw_id)
        self.assertNotIn("1789218715", cleaned)
        # Ensure person: is not left childless without {}
        self.assertIn("person: {}", cleaned)
        self.assertNotIn("person:\n        car:", cleaned)

    def test_clean_mask_leaves_valid_yaml_and_no_childless_keys(self):
        raw_id = "1789218715.393093"
        poly = "0.688,0.737,0.716,0.737,0.716,0.813,0.688,0.813"
        v, is_dict = _detect_config_version_and_format(self.config_v18, "wyze_camera")
        injected = _inject_temp_mask(self.config_v18, "wyze_camera", poly, raw_id, label="person", is_dict=is_dict)
        cleaned = _clean_config_masks(injected, raw_id)
        
        # Verify no lines end with ':' without children (which would parse as null/None in YAML)
        lines = cleaned.splitlines()
        for i, l in enumerate(lines):
            stripped = l.strip()
            indent = len(l) - len(l.lstrip(" "))
            if indent >= 4 and stripped.endswith(":") and not stripped.startswith("-"):
                has_child = False
                for next_l in lines[i + 1:]:
                    if not next_l.strip() or next_l.strip().startswith("#"):
                        continue
                    if len(next_l) - len(next_l.lstrip(" ")) > indent:
                        has_child = True
                    break
                self.assertTrue(has_child, f"Dangling childless key found: '{stripped}' at line {i+1}")


if __name__ == "__main__":
    unittest.main()
