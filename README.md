# homebridge-shelly-neo-valve

Homebridge plugin for the **Shelly Neo Smart Water Valve** (Gen3, "Powered by Shelly" XT1, app `neo-water-valve-advanced`). It talks to the valve over its local HTTP RPC interface; no cloud and no MQTT.

## What shows up in Apple Home

| Accessory | HomeKit service | Notes |
|---|---|---|
| Water Valve | Switch (default) or Valve | On = water open. Reads and sets the valve's `state` component. With `controlType: "valve"` it is Home's water faucet tile instead, which shows as running whenever the valve is open, even with no water flowing |
| Closed | Contact Sensor | Closed = water off. Home can notify on a contact sensor but not on a valve. (`valveSensors`) |
| Alarm | Leak Sensor | Trips when the valve shuts without Home telling it to (a valve alarm, the Shelly app or the button). Clears when it opens. (`valveSensors`) |
| Running too long | Leak Sensor | Trips when water has flowed without stopping for `alertAfterMinutes` (default 30) or `alertAfterLitres`. Stays on after a shut-off until the valve is opened again. |
| Holiday mode | Switch | While on, water running for `holidayAlertMinutes` (default 3) trips the Running too long sensor, and for `holidayShutOffMinutes` (default 0 = never) closes the valve. Remembered across restarts. |
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
  "controlType": "switch",
  "valveSensors": true,
  "alertAfterMinutes": 30,
  "shutOffAfterMinutes": 0,
  "holidayMode": true,
  "holidayAlertMinutes": 3,
  "holidayShutOffMinutes": 0,
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
| `controlType` | switch | `switch` (On = open) or `valve` (the faucet tile) |
| `valveSensors` | true | The Closed and Alarm sensors. False removes them |
| `alertAfterMinutes` | 30 | Trip the Running too long sensor after this many minutes of unbroken flow. 0 = off |
| `alertAfterLitres` | 0 | Same, by litres in one run. 0 = off |
| `shutOffAfterMinutes` | 0 | Close the valve after this many minutes of unbroken flow. 0 = never |
| `shutOffAfterLitres` | 0 | Same, by litres in one run. 0 = never |
| `holidayMode` | true | Adds the Holiday mode switch. False removes it |
| `holidayAlertMinutes` | 3 | In holiday mode, trip the Running too long sensor after this many minutes of unbroken flow |
| `holidayShutOffMinutes` | 0 | In holiday mode, close the valve after this many minutes. 0 = never; 10 suits an empty home |
| `atmosphericBar` | 1.013 | Subtracted from the reading when nothing flows |
| `snapshots` | true | Keep a JSON file of readings |
| `snapshotMinutes` | 10 | Minutes between saved rows (1 to 60) |
| `historyDays` | 14 | Days of rows kept (1 to 90) |
| `snapshotDir` | Homebridge storage `neo-valve` | Folder for `<host>.json` |

## Running too long

A run starts when the flow is above 0.05 L/min and ends once it has been zero for about 90 seconds (three polls), so a blip between polls does not split it. Minutes and litres are counted from the start of the run; litres come from the valve's own counter. A limit of 0 is off. A shut-off closes the valve with the same command Home uses, and the alert stays on until the valve is opened again. A bath or a hose left running on purpose counts as a long run, so choose limits that suit the home, and leave the shut-off off unless you want it.

Holiday mode uses the same sensor and the same run counting, with its own (shorter) limits, and the shut-off latches the same way. The snapshot's `latest` carries `holiday: true` while it is on, so the hub status can show it.

## Snapshot files

Two files per valve in `snapshotDir`: `<host>.json` (below, written every `snapshotMinutes`) and `<host>.now` (just the newest reading, rewritten at every poll, so a reader can get a reading at most `pollSeconds` old without the history).

## Snapshot file

`<snapshotDir>/<host>.json`, written atomically (mode 0644). `schema` 1, `device`, `atmospheric_bar`, `updated_at`, `latest` (the newest reading, with `run` when water is running: minutes, litres, alert), `days` (per local day: litres `l` and the pressure seen `pmin`, `pmax`, `ps` sum, `pn` samples; kept for 400 days) and `history`. A row holds `t`, `ok`, `valve_open`, `flow_lpm`, `flow_peak_lpm` (highest flow since the previous row), `pressure_bar` (real), `pressure_bar_raw`, `temperature_c`, `consumption_l` (the valve's counter) and `used_l` (litres since the previous row). A row with `ok: false` means the valve did not answer. No password or personal data is stored.

## Limits

- Password: set `username` (default `admin`) and `password` per device. The plugin answers the valve's HTTP digest (SHA-256) challenge, the same scheme as the other Shelly devices. With no password set on the valve, leave them out. Digest over HTTP is not encrypted, so pair it with network isolation.
- The valve's own alarm limits (temperature, pressure, flow) are set in the Shelly app, not here. The valve does not say why it closed, so the Alarm sensor is inferred.
- Opening or closing the valve changes the water supply to the home.
- Tested only against firmware 2.0.1 of the `S3XT-0S` model.

## Tile names and the valve's alarm limits (0.5.3)

**Names.** The five tiles in Apple Home are called Water Valve Switch, Water Valve Status, Water Leak Alarm, Water Holiday Mode and Water Suspected Leak Alarm. Each name can be changed in the settings (`switchName`, `statusName`, `alarmName`, `holidayName`, `suspectedLeakName`); empty uses the default.

**Alarm limits.** The valve keeps its own minimum and maximum for water temperature, pressure and flow, and closes when a reading goes outside one. At every start the plugin reads them and writes them to the Homebridge log. It changes a limit **only** when you fill in the matching settings (`limitTempMin`/`limitTempMax` in °C, `limitPressureMinBar`/`limitPressureMaxBar` in bar, `limitFlowMin`/`limitFlowMax` in L/min). With one of a pair filled in, the other keeps the valve's current value. A pair whose minimum is not below its maximum, or that is far outside what makes sense, is refused and logged. Leave them empty and the plugin never writes to the valve. Filled-in limits are put back at the next restart if someone changed them in the Shelly app.
