# homebridge-shelly-neo-valve

Homebridge plugin for the **Shelly Neo Smart Water Valve** (Gen3, "Powered by Shelly" XT1, app `neo-water-valve-advanced`). It talks to the valve over its local HTTP RPC interface; no cloud and no MQTT.

## What shows up in Apple Home

| Accessory | HomeKit service | Notes |
|---|---|---|
| Valve (open/close) | Valve | Reads and sets the valve's `state` component |
| Water temperature | Temperature Sensor | Real °C |
| Water pressure (kPa) | Light Sensor | HomeKit has no pressure sensor. The number is the real kPa value, but Apple Home labels it "lux". |
| Water flow (L/min) | Light Sensor | HomeKit has no flow sensor. The number is the real L/min value, labelled "lux". |

All four sit in one accessory per valve. Tiles show a "No Response" fault if the valve is unreachable.

## Config

```json
{
  "platform": "ShellyNeoValve",
  "name": "Shelly Neo Valve",
  "pollSeconds": 15,
  "devices": [{ "name": "Water Valve", "host": "192.168.1.50", "username": "admin", "password": "..." }]
}
```

Reserve the valve's address in the router.

## Limits

- Password: set `username` (default `admin`) and `password` per device. The plugin answers the valve's HTTP digest (SHA-256) challenge, the same scheme as the other Shelly devices. With no password set on the valve, leave them out. Digest over HTTP is not encrypted, so pair it with network isolation.
- Total water used (`water_consumption`) is not exposed.
- Opening or closing the valve changes the water supply to the home.
- Tested only against firmware 2.0.1 of the `S3XT-0S` model.
