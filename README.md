# homebridge-shelly-neo-valve

Homebridge plugin for the **Shelly Neo Smart Water Valve** (Gen3, "Powered by Shelly" XT1, app `neo-water-valve-advanced`). It talks to the valve over its local HTTP RPC interface; no cloud and no MQTT.

## What shows up in Apple Home

| Accessory | HomeKit service | Notes |
|---|---|---|
| Valve (open/close) | Valve, shown as a water faucet | Reads and sets the valve's `state` component. "In use" follows open, so Home shows On, not Starting |
| Closed | Contact Sensor | Closed = water off. Home can notify on a contact sensor but not on a valve. (`valveSensors`) |
| Alarm | Leak Sensor | Trips when the valve shuts without Home telling it to (a valve alarm, the Shelly app or the button). Clears when it opens. (`valveSensors`) |
| Water temperature | Temperature Sensor | Real °C. (`homeSensors`) |
| Water pressure in bar | Light Sensor | HomeKit has no pressure sensor. The number is the real water pressure in bar, labelled "lux" by Home. (`homeSensors`) |
| Water flow in L per min | Light Sensor | The real L/min value, labelled "lux". (`homeSensors`) |

All sit in one accessory per valve. Tiles show a "No Response" fault if the valve is unreachable.

**Pressure:** the valve shows absolute pressure while no water flows (Shelly's FAQ), so the plugin subtracts atmospheric pressure (default 1.013 bar) at zero flow. The raw value is kept in the snapshot file.

## Config

```json
{
  "platform": "ShellyNeoValve",
  "name": "Shelly Neo Valve",
  "pollSeconds": 15,
  "homeSensors": true,
  "valveSensors": true,
  "atmosphericBar": 1.013,
  "snapshots": true,
  "snapshotMinutes": 10,
  "historyDays": 14,
  "snapshotDir": "/var/lib/oncue/water",
  "devices": [{ "name": "Water Valve", "host": "192.168.1.50", "username": "admin", "password": "..." }]
}
```

Reserve the valve's address in the router.

| Option | Default | Meaning |
|---|---|---|
| `pollSeconds` | 15 | How often the valve is read (5 to 300) |
| `homeSensors` | true | Temperature, pressure and flow tiles in Home. False removes them |
| `valveSensors` | true | The Closed and Alarm sensors. False removes them |
| `atmosphericBar` | 1.013 | Subtracted from the reading when nothing flows |
| `snapshots` | true | Keep a JSON file of readings |
| `snapshotMinutes` | 10 | Minutes between saved rows (1 to 60) |
| `historyDays` | 14 | Days of rows kept (1 to 90) |
| `snapshotDir` | Homebridge storage `neo-valve` | Folder for `<host>.json` |

## Snapshot file

`<snapshotDir>/<host>.json`, written atomically (mode 0644). `schema` 1, `device`, `atmospheric_bar`, `updated_at`, `latest` (the newest reading) and `history`. A row holds `t`, `ok`, `valve_open`, `flow_lpm`, `flow_peak_lpm` (highest flow since the previous row), `pressure_bar` (real), `pressure_bar_raw`, `temperature_c`, `consumption_l` (the valve's counter) and `used_l` (litres since the previous row). A row with `ok: false` means the valve did not answer. No password or personal data is stored.

## Limits

- Password: set `username` (default `admin`) and `password` per device. The plugin answers the valve's HTTP digest (SHA-256) challenge, the same scheme as the other Shelly devices. With no password set on the valve, leave them out. Digest over HTTP is not encrypted, so pair it with network isolation.
- The valve's own alarm limits (temperature, pressure, flow) are set in the Shelly app, not here. The valve does not say why it closed, so the Alarm sensor is inferred.
- Opening or closing the valve changes the water supply to the home.
- Tested only against firmware 2.0.1 of the `S3XT-0S` model.
