# Relaynet-Internet Gateway

(This README is just a placeholder for the time being)

## NATS Streaming Channels

- `pdc-parcel.${localGatewayAddress}` where `${localGatewayAddress}` is the private address of the local gateway. Parcels received via Internet-based PDCs (e.g., PoHTTP) are published on this channel.
- `crc-cargo`. Cargo received via CRC (e.g., CogRPC) are published here.

## Development

Create collection:

```
mongo.db.createCollection('own_certificates');
```
