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

## Before you start: set the valve's own limits

Set the valve's alarm limits first, in the Shelly app or the valve's web page (Config tab): temperature, pressure and, above all, flow, each with the action Close. Out of the box the flow limit is far too high to ever trip. The plugin never changes them, but at every start it reads them, logs them and warns in the Homebridge log ("check the valve first") if they look unset or the action is not Close.

## Tile names and the valve's alarm limits (0.5.3)

**Names.** The five tiles in Apple Home are called Water Valve Switch, Water Valve Status, Water Critical Fault Sensor, Water Holiday Mode and Water Unexpected Flow Sensor. Each name can be changed in the settings (`switchName`, `statusName`, `alarmName`, `holidayName`, `suspectedLeakName`); empty uses the default.

**The valve's own settings.** The alarm limits (temperature, pressure, flow), the display units, what the valve does when power returns and its time zone are set on the valve, in the Shelly app or web page. The plugin never changes them. At every start, and every six hours, it reads them, writes them to the Homebridge log, and keeps a copy (`valve_settings`) beside the readings in the snapshot file, so a reading can be understood against the settings the valve had. A change made on the valve is logged as a warning. Pressure is in bar and flow in L/min in the copy; the valve itself stores flow in a unit 1000 times smaller and shows it as L/min x1000 on its page.

## Two kinds of alarm (0.5.5)

- **Critical fault sensor:** the valve's own alarms (temperature, pressure, flow limits), set on the valve. When one trips the valve closes by itself, and this sensor shows the valve shut without being told to. The plugin cannot tell which limit tripped, nor tell it apart from a press of the button or the Shelly app.
- **Unexpected flow sensor:** the plugin's own rules, set in the Homebridge settings: water running for too long (forgotten tap or bath), and in Holiday mode water running for a few minutes, or more than an allowance of litres in 24 hours (`holidayAllowanceLitres`, counted from the valve's water counter, so a slow leak that never makes one long run still adds up). `holidayIgnoreFrom` and `holidayIgnoreTo` (HH:MM, the Pi's clock, may cross midnight) are a daily window when holiday rules look away, for sprinklers; the normal running-too-long limit still applies in the window. The allowance clears by itself when the litres in the last 24 hours drop back under it. Both are off until set.

## Units (0.5.5)

`homeUnits` sets the units of the pressure and flow tiles in Apple Home: by default the same as the valve (read from its own page at start, so PSI and litres on the valve show as PSI and L/min in Home), or metric (bar, L/min) or US (PSI, gal/min). The tile names carry the unit. Snapshots, the hub status, the On Cue app and Backstage always use bar and litres. The atmospheric pressure setting stays in bar.
