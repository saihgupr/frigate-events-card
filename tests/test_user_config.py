import sys
from unittest.mock import MagicMock
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
sys.path.insert(0, '.')

from custom_components.frigate_temp_mask import (
    _parse_frigate_version,
    _detect_config_version_and_format,
    _inject_temp_mask,
    _box_to_polygon,
    _clean_config_masks,
    _parse_temp_masks_from_config,
)

user_config = """mqtt:
  enabled: true
  host: 192.168.1.199
  port: 1883

go2rtc:
  streams:
    wyze_camera:
      - rtsp://192.168.1.188:8554/1080p
  api:
    listen: 0.0.0.0:1984
  rtsp:
    listen: 0.0.0.0:8554
  webrtc:
    listen: 0.0.0.0:8555
    candidates:
      - 192.168.1.211:8555

ffmpeg:
  hwaccel_args: preset-intel-qsv-h264
  output_args:
    record: preset-record-generic-audio-copy

detectors:
  ov:
    type: openvino
    device: AUTO
    model_path: /openvino-model/ssdlite_mobilenet_v2.xml

model:
  width: 300
  height: 300
  input_tensor: nhwc
  input_pixel_format: bgr
  labelmap_path: /openvino-model/coco_91cl_bkgr.txt

detect:
  enabled: true
  width: 1920
  height: 1080
  fps: 5
  max_disappeared: 100
  min_initialized: 2

objects:
  track:
    - car
    - person
    - umbrella
    - bicycle
    - motorcycle
    - door
    - window
    - cat
  filters:
    car:
      min_area: 500
      min_score: 0.5
    person:
      min_area: 500
      min_score: 0.6
    cat:
      min_area: 200
    umbrella:
      threshold: 0.95
    motorcycle:
      threshold: 0.9

record:
  enabled: true
  continuous:
    days: 1
  detections:
    pre_capture: 1
    post_capture: 30
    retain:
      days: 30
      mode: all
snapshots:
  enabled: true
  crop: false
  bounding_box: false
  timestamp: false
  quality: 100
  retain:
    default: 100

timestamp_style:
  position: br
  format: '%Y-%m-%d %H:%M:%S  '
  effect: shadow
  thickness: 1

cameras:
  wyze_camera:
    ffmpeg:
      input_args: preset-rtsp-restream
      inputs:
        - path: rtsp://127.0.0.1:8554/wyze_camera
          roles:
            - detect
            - record

    zones:
      front_a:
        coordinates: 0,0.375,0.58,0.425,0.592,1,0,1
        inertia: 1
        loitering_time: 0
      front_b:
        coordinates: 0.582,0.426,1,0.531,1,1,0.594,1
        inertia: 1
        loitering_time: 0
      side_a:
        coordinates: 403,399,397,0,0,0,0,434
        inertia: 1
      side_b:
        coordinates: 0.518,0,0.518,0.27,0.211,0.376,0.208,0
        inertia: 1

        loitering_time: 0
    motion:
      threshold: 25
      improve_contrast: true
      mask:
        motion_mask_1:
          friendly_name: Motion Mask 1
          enabled: true
          coordinates: 
            0.45,0.002,0.388,0.235,0.573,0.255,0.845,0.25,0.999,0.309,1,0
        motion_mask_2:
          friendly_name: Motion Mask 2
          enabled: true
          coordinates: 0,0.002,0.649,0,0.407,0.062,0,0.261
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
        bicycle: {}
        motorcycle: {}
      mask:
        object_mask_1:
          friendly_name: Object Mask 1
          enabled: true
          coordinates: 0,0.192,0.275,0.118,0.402,0,0,0
        object_mask_2:
          friendly_name: Object Mask 2
          enabled: true
          coordinates: 
            0.39,0.223,0.449,0,1,0,0.997,0.308,0.843,0.243,0.574,0.234
        object_mask_3:
          friendly_name: Object Mask 3
          enabled: true
          coordinates: 0.076,0.883,0.193,0.871,0.133,0.665,0.08,0.72
    detect:
      annotation_offset: 150
version: 0.18-0
"""

v, is_dict = _detect_config_version_and_format(user_config, "wyze_camera")
print(f"Detected: version={v}, is_dict={is_dict}")

poly = _box_to_polygon([0.2, 0.3, 0.1, 0.1], 1920, 1080, padding=0.10, normalized=True)
print(f"Polygon: {poly}")

for label in ["car", "person", "cat", ""]:
    out = _inject_temp_mask(user_config, "wyze_camera", poly, f"mask_{label or 'none'}", label=label, is_dict=is_dict)
    print(f"\n==================== INJECTION FOR LABEL: '{label}' ====================")
    lines = out.splitlines()
    for i, line in enumerate(lines):
        if f"temp_mask_mask_{label or 'none'}" in line:
            for c in lines[max(0, i-6):min(len(lines), i+10)]:
                print(c)
