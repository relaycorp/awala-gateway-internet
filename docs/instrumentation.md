---
nav_order: 30
permalink: /instrumentation
---
# Instrumentation

We use [pino](https://getpino.io/) with [`@relaycorp/pino-cloud`](https://www.npmjs.com/package/@relaycorp/pino-cloud) to provide structured logs, which could in turn be consumed to provide [instrumentation](https://john-millikin.com/sre-school/instrumentation).

## Common logging attributes

The following attributes are shared by multiple logs:

- `parcelId`: The id of a parcel, which can be useful to track its processing from delivery to collection.
- `cargoId`: The id of a cargo, which can be useful to track its processing from delivery to collection.
- `privatePeerId`: The id of a private gateway paired or potentially paired to this Internet gateway. Useful to find all the events involving a specific private gateway.

## Log levels

We use log levels as follows:

- `debug`: Events that are only relevant during development or debugging. They should be ignored in production.
- `info`: Events for any outcome observed outside the gateway, or any unusual interaction with a backing service.
- `warning`: Something has gone wrong but it's being handled gracefully. Triage can start on the next working day.
- `error`: Something has gone wrong and triage must start within a few minutes. Wake up an SRE if necessary.
- `fatal`: A process has crashed.
