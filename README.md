# Homebridge Shelly Neo Water Valve

Puts the **Shelly Neo Smart Water Valve** (Gen3, "Powered by Shelly" XT1) into Apple Home, adds alarms you can get notifications for, and watches for the kind of trouble a plain valve cannot: a tap or bath left running, or a slow leak while the house is empty. It talks to the valve over your home network. No cloud, no MQTT.

<!-- IMAGE: hero - the tiles in Apple Home -->

## What you get

One accessory in Apple Home with these tiles. Every name can be changed in the plugin settings.

| Tile | What it is | Use it for |
|---|---|---|
| **Water Valve Switch** | On/Off switch. On = water open | Turning the mains water off and on |
| **Water Valve Status** | Contact sensor. Closed = water off | A notification whenever the water is switched off or on |
| **Water Critical Fault Sensor** | Leak sensor | The valve closed **by itself** (one of the valve's own alarms) |
| **Water Unexpected Flow Sensor** | Leak sensor | Water running longer than it should: forgotten tap or bath, or a slow leak in Holiday mode |
| **Water Slow Leak Sensor** | Leak sensor | Optional. Trips when the nightly quiet-window test sees water moving |
| **Water Holiday Mode** | Switch | Turn on when the home is empty: any water running becomes an alarm |
| Water temperature, pressure, flow | Sensors (optional) | The numbers. Home has no pressure or flow sensor, so those two appear as light sensors: the number is the real value (Home labels it "lux") |

<!-- IMAGE: tiles - the tiles in Apple Home, named -->

## The three kinds of alarm

- **Critical fault** is the valve's own protection. You set temperature, pressure and flow limits **on the valve**. If a reading goes outside a limit the valve closes the water itself, even if Homebridge, your Wi-Fi or the internet is down. The plugin then turns the Critical Fault sensor on. It cannot tell which limit tripped, and it looks the same as someone pressing the button on the valve.
- **Unexpected flow** is the plugin's own watch, set in the Homebridge settings:
  - *Running too long:* water that has not stopped for 30 minutes (you choose), or has used a set number of litres.
  - *Holiday mode:* with the switch on, water running for just 3 minutes (you choose) is an alarm. It can also add up the litres used in the last 24 hours and alarm over an allowance, which catches slow leaks that never make one long run. A daily time window lets sprinklers run without an alarm.
  - Either rule can be set to close the valve too (off by default).
  - *Small flows are ignored.* Flow at or below a limit you set (**Ignore flow below**) does not count as water running, so an ice maker or a slow top-up does not start a run. About 0.5 litres a minute suits most homes. A real leak that small is caught by the slow leak test instead.
- **Slow leak test** is a nightly check for the leak that never makes one long run. In a short quiet window (3:00 for 5 minutes by default) the valve's water counter should not move at all. If more than the allowance (0.5 litres by default) passes, the **Water Slow Leak Sensor** trips. It only watches: it never closes the valve. It stays on until a later night's test passes, and survives a Homebridge restart. If Homebridge was down for the window, that night gives no result either way. Switch it on in the settings (it is off by default); the sensor appears in Home once it is on.

## Before you start: set up the valve itself

Do this first, with the valve's own app or web page. The plugin never changes these settings; it only reads them and warns you in the Homebridge log if they look unset.

1. Add the valve to your Wi-Fi and give it a **fixed address** (reserve it in your router).
2. Set a **device password**, and note the username (admin) and password: the plugin needs them.
3. Check the **location and time zone** are right.
4. On the valve's **Config** tab set the three alarms, each with the action **Close**:

   | Alarm | Suggested | Why |
   |---|---|---|
   | Flow | Maximum a little above the most the home uses at once (for example a shower and two toilets), not the factory value | Catches a burst pipe. Out of the box this limit is far too high ever to trip |
   | Pressure | Minimum a little under normal, maximum about 5.5 bar | Catches a mains failure or a regulator fault. The valve shows absolute pressure, about 1 bar above a gauge |
   | Temperature | 3 to 50 °C | Frost, or a hot supply where there should not be one |

   Leave "on power restored" as **Nothing** so the valve stays as it was after a power cut.

<!-- IMAGE: shelly-config - the valve's Config tab with the three alarms -->

## Install

1. In the Homebridge UI open **Plugins**, search for `homebridge-shelly-neo-valve` and install it.
2. Open the plugin's **Settings**. Under **Valves** add the valve: a name, its address, `admin`, and the password.
3. Leave the other options as they are for now. Save.
4. Restart Homebridge. Run the plugin as a **child bridge** if the UI offers it. Add the new bridge to Apple Home with the code from the Homebridge UI.
5. Check the Homebridge log. You should see a line like:
   `valve settings: temperature 3 to 50 C (close), pressure 1 to 5.5 bar (close), flow 0 to 60 L/min (close)`.
   If you see **"check the valve first"**, the valve's limits are not set properly yet: go back to the previous section.

<!-- IMAGE: homebridge-settings - the plugin settings with the valve added -->

## Set up notifications in Apple Home

The alarms only tell you something if Home sends a notification. For each of **Water Critical Fault Sensor**, **Water Unexpected Flow Sensor** and, if you use the nightly test, **Water Slow Leak Sensor** (and **Water Valve Status** if you want to know when the water is switched off): press and hold the tile, open **Settings**, then **Status & Notifications**, and turn on notifications. Home treats them as leak sensors, so they are loud.

<!-- IMAGE: home-notifications - the Home notification setting for a sensor -->

## Using it

- **Normal days:** nothing to do. The Switch shows and controls the water.
- **Going away:** turn on **Water Holiday Mode**, by hand or with a Home automation when the last person leaves. Turn it off when you are back.
- **After an alarm:** find the cause first. The Critical Fault sensor clears when the valve is opened again. The Unexpected Flow sensor clears when the flow stops (or, if the plugin shut the valve, when you open it again). The Slow Leak sensor clears when a later night's test passes, so look for the cause and then wait for the next night's result.
- **A bath or a long fill:** if you set the plugin to close the valve after some minutes of unbroken flow, a bath or fill that runs longer than that will be cut off. The alert comes first, so you can act before the valve closes. Open the valve again from Home, the Shelly app or the button on the valve.

## A good starting point

These are the settings in use in one family home, with an ice maker and a bath. Change them to suit.

| Setting | Value | Why |
|---|---|---|
| Alert when water has run for | 15 minutes | Longer than any normal tap, shower or washing machine fill |
| Shut the water off after | 20 minutes | Stops a forgotten tap or a burst while someone is in |
| Ignore flow below | 0.5 L/min | An ice maker's refill is not a leak |
| Nightly slow leak test | On, 03:00, 5 minutes, 0.5 L | Nobody is using water at 3 am, so any movement is worth knowing about |
| Holiday mode alert after | 3 minutes | Nobody is home, so any running water matters |

## Settings you may want

All are optional and in the plugin settings. Defaults in brackets.

| Setting | What it does |
|---|---|
| Alert when water has run for (30 min) | Unexpected flow after this long without stopping. 0 turns it off |
| Ignore flow below (L/min) | Flow at or below this does not count as water running. Use about 0.5 for an ice maker or slow top-up. Default 0.05 |
| Alert when a run has used (0 L) | The same, by litres |
| Shut the water off after (0 = never) | Close the valve after this many minutes or litres of unbroken flow. This also stops a bath left running on purpose |
| Holiday mode alert after (3 min) | How soon water running counts in Holiday mode |
| Holiday mode shut off after (0 = never) | 10 minutes suits an empty home |
| Holiday allowance, litres in 24 hours (0 = off) | Slow leak alarm. Choose a little above what an empty home really uses |
| Holiday ignore from / until (empty) | Daily window, for sprinklers, for example 05:00 to 07:00. The normal running-too-long limit still applies |
| Nightly slow leak test (off) | Adds a Slow Leak Sensor. Only watches, never closes the valve |
| Slow leak test time (03:00) | Start of the quiet window, on the Pi's clock, 24-hour time |
| Slow leak test length (5 min) | How long the window lasts |
| Slow leak test allowance (0.5 L) | More than this in the window fails the test. A little above what an ice maker uses in one fill |
| Units in Apple Home (same as the valve) | Pressure and flow in bar and L/min, or PSI and gal/min. Matches the valve's own page by default |
| Tile names | Rename any of the tiles |
| Control in Apple Home (switch) | A plain On/Off switch. The alternative is Home's faucet tile, which shows as "running" whenever the valve is open, even with no water flowing |

## If something is not right

| You see | What it means |
|---|---|
| Tiles show "No Response" | The plugin cannot reach the valve: check its address, power and Wi-Fi, and the password |
| "the valve refused the username/password" in the log | The username or password in the plugin settings does not match the valve |
| "check the valve first" in the log | The valve's own limits look unset, or their action is not Close: set them on the valve |
| "the valve's settings changed" in the log | Someone changed a setting on the valve. Make sure it was intended |
| Pressure looks about 1 bar high on the valve's page | The valve reports absolute pressure at zero flow; the plugin and Home show the real (gauge) pressure |
| An old tile name stays | Close and reopen the Home app. Home sometimes keeps old names for a while |

## Good to know

- Opening or closing the valve changes the water supply to the home. Test alarms when someone can open the valve again.
- The slow leak test uses the valve's own counter, so it also notices a trickle that the "ignore flow below" setting hides. Something that fills at 3 am (an ice maker is about a tenth of a litre a cycle) can use up part of the allowance: raise it a little if the test fails for no reason.
- The valve's own limits protect you even when everything else is down. The plugin's Unexpected Flow rules need Homebridge running.
- Tested with firmware 2.0.1 of the `S3XT-0S` model.

---

## For installers and integrators

The plugin saves a snapshot of the readings every few minutes to a small JSON file, for other tools to read (the On Cue hub reads it). It also keeps a copy of the valve's own settings beside the readings, so a reading can be understood against the limits and units the valve had at the time. No password or personal data is stored.

- **Units:** snapshots always use bar (real, gauge pressure; the raw value is kept), litres and °C. The valve itself stores pressure in kPa (absolute) and flow in m³/min, and shows flow as L/min x1000 on its page. The atmospheric pressure setting (1.013 bar) is what is subtracted at zero flow.
- **Running too long:** a run starts when flow is above the "Ignore flow below" setting (at least 0.05 L/min) and ends once it has been zero for about 90 seconds, so a blip between polls does not split it. Litres come from the valve's own counter. The Holiday allowance adds litres from the counter over the last 24 hours, only while Holiday mode is on and outside the ignore window.
- **Alarm sensor:** the valve does not say why it closed, so the Critical Fault sensor is inferred: the valve was open and is now closed, and the plugin did not command it in the last minute.

- **Slow leak test:** counts litres from the valve's counter between readings inside the window. A counter that goes down is treated as reset. It needs at least two readings in the window to give a result. The result is 'pass' or 'fail' on the poll that ends the window, and a failure is kept in the accessory's saved context so it survives a restart.

### Snapshot files

Two files per valve in `snapshotDir`: `<host>.json` (below, written every `snapshotMinutes`) and `<host>.now` (just the newest reading, rewritten at every poll, so a reader can get a reading at most `pollSeconds` old without the history).

### The rules, as the plugin is running them

Each snapshot, and the `.now` file, also carries `plugin_rules`: the rules the plugin is actually running, so another tool can describe what is being watched without reading the Homebridge config. Numbers, flags and `HH:MM` times only. Fields: `alert_after_minutes`, `alert_after_litres`, `shut_off_after_minutes`, `shut_off_after_litres` (0 is off), `ignore_flow_lpm` (flow at or below this is not counted as running), `slow_leak_test` (`enabled`, `time`, `minutes`, `litres`), and `holiday` (`enabled`, `alert_minutes`, `shut_off_minutes`, `allowance_litres_24h`, `ignore_from`, `ignore_to`). Change a setting, restart Homebridge, and these follow. `valve_settings` holds the valve's own limits as last read.

### Snapshot file format

`<snapshotDir>/<host>.json`, written atomically (mode 0644). `schema` 1, `device`, `atmospheric_bar`, `updated_at`, `latest` (the newest reading, with `run` when water is running: minutes, litres, alert), `days` (per local day: litres `l` and the pressure seen `pmin`, `pmax`, `ps` sum, `pn` samples; kept for 400 days) and `history`. A row holds `t`, `ok`, `valve_open`, `flow_lpm`, `flow_peak_lpm` (highest flow since the previous row), `pressure_bar` (real), `pressure_bar_raw`, `temperature_c`, `consumption_l` (the valve's counter) and `used_l` (litres since the previous row). A row with `ok: false` means the valve did not answer. No password or personal data is stored.

### Limits

- Password: set `username` (default `admin`) and `password` per device. The plugin answers the valve's HTTP digest (SHA-256) challenge, the same scheme as the other Shelly devices. With no password set on the valve, leave them out. Digest over HTTP is not encrypted, so pair it with network isolation.
- The valve's own alarm limits (temperature, pressure, flow) are set in the Shelly app, not here. The valve does not say why it closed, so the Alarm sensor is inferred.
- Opening or closing the valve changes the water supply to the home.
- Tested only against firmware 2.0.1 of the `S3XT-0S` model.

