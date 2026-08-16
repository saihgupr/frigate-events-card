# Dynamic Temporary Masking Specification for Frigate NVR & Frigate Events Card

## 1. Overview & Objective

This specification documents the architecture, APIs, mathematical models, and implementation steps for dynamically injecting and expiring temporary false-positive masks into Frigate NVR 0.13 from Home Assistant and the Frigate Events Card.

The purpose of this feature is to allow users to temporarily ignore stationary false positives (such as wheelbarrows, garden tools, lawn ornaments, or shadows) directly from actionable notifications or from the Frigate Events Card without opening Frigate's configuration UI.

---

## 2. Frigate 0.13 Telemetry & Masking Architecture

### A. Event Payload & Bounding Box Structure
When Frigate creates an event (accessible via `GET /api/events/<event_id>` or MQTT `frigate/events`), the `data.box` field contains normalized bounding box coordinates:

```json
{
  "id": "1786816654.137289-fuli6r",
  "camera": "wyze_camera",
  "label": "person",
  "data": {
    "box": [0.4322916666666667, 0.5342592592592592, 0.11614583333333334, 0.26481481481481484],
    "score": 0.61767578125
  }
}
```

* **Box format in Frigate 0.13 API:** `[x, y, w, h]` (normalized floats from 0.0 to 1.0).
  * `x`: Normalized horizontal offset from left edge ($0.0 \dots 1.0$)
  * `y`: Normalized vertical offset from top edge ($0.0 \dots 1.0$)
  * `w`: Normalized width ($0.0 \dots 1.0$)
  * `h`: Normalized height ($0.0 \dots 1.0$)

---

### B. Detect Stream Resolution Query
Frigate masks use pixel coordinates based on the camera's detect stream resolution (not the main/sub stream recording resolution).

* **API Endpoint:** `GET /api/config`
* **Path in JSON:** `cameras.<camera_name>.detect.width` and `cameras.<camera_name>.detect.height` (e.g. `1920` x `1080`).

---

### C. Coordinate Conversion & Safety Padding Math
Frigate object masks check whether the **bottom-center point** $(x_{\text{center}}, y_{\text{max}})$ of an object's bounding box falls inside the mask polygon.

To ensure daylight shifts, morning/afternoon sun angles, ground shadows, and camera vibrations do not push the object outside the mask, apply **20% outward expansion padding** (with +25% on the bottom edge for ground shadows):

$$\text{pad}_x = w_{\text{px}} \times 0.20, \quad \text{pad}_{y\text{_top}} = h_{\text{px}} \times 0.20, \quad \text{pad}_{y\text{_bottom}} = h_{\text{px}} \times 0.25$$

1. Convert normalized box to pixel coordinates:
   $$x_{1\text{px}} = x \times W, \quad y_{1\text{px}} = y \times H$$
   $$x_{2\text{px}} = (x + w) \times W, \quad y_{2\text{px}} = (y + h) \times H$$
2. Apply padding with boundary clamping:
   $$x_{\text{min}} = \max(0, \operatorname{round}(x_{1\text{px}} - \text{pad}_x))$$
   $$y_{\text{min}} = \max(0, \operatorname{round}(y_{1\text{px}} - \text{pad}_{y\text{_top}}))$$
   $$x_{\text{max}} = \min(W, \operatorname{round}(x_{2\text{px}} + \text{pad}_x))$$
   $$y_{\text{max}} = \min(H, \operatorname{round}(y_{2\text{px}} + \text{pad}_{y\text{_bottom}}))$$
3. Format 4-point polygon string (Top-Left, Top-Right, Bottom-Right, Bottom-Left):
   $$\text{"}x_{\text{min}},y_{\text{min}},x_{\text{max}},y_{\text{min}},x_{\text{max}},y_{\text{max}},x_{\text{min}},y_{\text{max}}\text{"}$$

*Example Output for 1080p Wheelbarrow with 20% Padding:* `766,499,1136,499,1136,968,766,968`

---

### D. Frigate Config Injection & In-Place Reload
Frigate 0.13 supports updating the active configuration without stopping the host container:

1. **Read Configuration:** `GET http://<frigate_ip>:5000/api/config/raw`
2. **Inject Polygon with ID Tag:**
   ```yaml
   objects:
     mask:
     - 812,554,1071,554,1071,886,812,886 # TEMP_MASK_1786816654
   ```
3. **Save and Reload Behavior:**
   * **On Mask Addition (`add`):**
     * `POST http://<frigate_ip>:5000/api/config/save?restart=1`
     * Header: `Content-Type: text/plain`
     * Body: Complete updated raw YAML string.
     * *Behavior:* Writes `config.yml` to disk and immediately reloads internal multiprocessing detector/ffmpeg workers within 2 seconds so the false alarm stops notifying right away.
   * **On Mask Removal / Expiry (`remove` / `prune-all`):**
     * `POST http://<frigate_ip>:5000/api/config/save` (WITHOUT `?restart=1`)
     * Header: `Content-Type: text/plain`
     * Body: Cleaned raw YAML string.
     * *Behavior:* Updates `config.yml` on disk silently without dropping active camera connections or interrupting ongoing detections during the day. The cleaned configuration will naturally load on the nightly container reboot.

---

## 3. Active Home Assistant Backend Setup

The production setup currently deployed in the user's environment:

### A. Python Engine Script
* **Location:** `/config/scripts/frigate_temp_mask.py` inside Home Assistant container.
* **Capabilities:**
  * `python3 frigate_temp_mask.py add --camera wyze_camera --event-id <ID> --mask-id <ID>`
  * `python3 frigate_temp_mask.py remove --mask-id <ID>`
  * `python3 frigate_temp_mask.py prune-all`
* If only `--event-id` is passed, the script automatically queries Frigate's API to fetch the camera name and bounding box.

### B. Shell Commands (`/config/shell_commands.yaml`)
```yaml
frigate_add_temp_mask: python3 /config/scripts/frigate_temp_mask.py add --camera "{{ camera }}" --box "{{ box }}" --event-id "{{ event_id }}" --mask-id "{{ mask_id }}"
frigate_remove_temp_mask: python3 /config/scripts/frigate_temp_mask.py remove --mask-id "{{ mask_id }}"
frigate_prune_all_temp_masks: python3 /config/scripts/frigate_temp_mask.py prune-all
```

### C. Home Assistant Helpers
* `timer.frigate_temp_mask`: 24-hour countdown timer (`duration: "24:00:00"`).
* `input_text.frigate_temp_mask_active`: Stores active mask ID.

### D. Automations
* `automation.frigate_notifications`: Includes `Ignore False Alarm (24h Mask)` actionable notification button with event ID tag.
* `automation.frigate_handle_temporary_mask_action`: Catches `mobile_app_notification_action` and `ios.notification_action_fired` (action: `MUTE_TEMPORARY_OBJECT`), triggers injection, starts 24h timer.
* `automation.frigate_clean_up_temporary_mask_on_expiry_or_cancel`: Triggers on `timer.finished` or `CANCEL_FRIGATE_MASK` action to prune mask from Frigate config.

---

## 4. Frigate Events Card Frontend Integration Design

When adding this functionality directly into `frigate-events-card`:

### A. UI Placement
Add an action button or context menu option on each event card item:
* **Icon:** `mdi:shield-outline` or `mdi:eye-off-outline`
* **Tooltip / Label:** `Ignore False Alarm (24h Mask)`

### B. Service Call Execution
The card interacts with Home Assistant using the standard `this.hass.callService()` API:

```typescript
// Handler inside frigate-events-card
async function maskEvent(hass: any, event: { id: string; camera: string }) {
  const maskId = event.id.includes('-') ? event.id.split('-')[0] : event.id;

  // 1. Add mask in Frigate
  await hass.callService('shell_command', 'frigate_add_temp_mask', {
    camera: event.camera,
    event_id: event.id,
    mask_id: maskId
  });

  // 2. Start 24h timer
  await hass.callService('timer', 'start', {
    entity_id: 'timer.frigate_temp_mask',
    duration: '24:00:00'
  });

  // 3. Update tracking helper
  await hass.callService('input_text', 'set_value', {
    entity_id: 'input_text.frigate_temp_mask_active',
    value: maskId
  });
}
```

### C. Optional Card Configuration Schema
```yaml
type: custom:frigate-events-card
camera: wyze_camera
enable_temp_mask: true
temp_mask_duration: '24:00:00'
```

---

## 5. Future Custom Component (`custom_components/frigate_temp_mask`) Roadmap

If packaging this as an independent HACS integration:

1. **Native Services:**
   * `frigate_temp_mask.add_mask` (`event_id`, `camera`, `duration_hours`, `padding_percent`)
   * `frigate_temp_mask.remove_mask` (`mask_id`)
   * `frigate_temp_mask.prune_all`
2. **Built-in Async Scheduling:**
   * Use `hass.loop.call_later()` or `async_track_point_in_time()` for automatic expiration without requiring manual UI helpers.
3. **Automatic Frigate Host Resolution:**
   * Query existing `frigate` config entry in `hass.data["frigate"]` to obtain the URL (`http://<ip>:5000`) automatically.
4. **State Sensor:**
   * Provide `sensor.frigate_active_masks` with attributes containing active mask boundaries and remaining countdown times.
