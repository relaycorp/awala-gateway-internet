---
layout: page
title: Relaynet-Internet Gateway
---
# Relaynet-Internet Gateway

TODO

## Architecture and Backing Services

TODO

## Releases

This image is automatically pushed to the Docker repository [`relaycorp/relaynet-internet-gateway`](https://hub.docker.com/r/relaycorp/relaynet-internet-gateway). Using the `latest` tag is not recommended: Instead, the tag for the corresponding version should be used (e.g., `v1.2.1`). This project uses [semantic versioning v2](https://semver.org/).

The changelog is available on GitHub.

## Processes

TODO

## Development

Make sure to install the development dependencies when contributing to this project: Docker, docker-compose and Node.js v12+.

This project can be installed in development mode like any other Node.js project: By running `npm install` from the root of the repository.

To run the unit test suite, run `npm test` on the host computer (i.e., without running Docker).

To start the long-running processes, run: `docker-compose up --build --remove-orphan`.

The PoHTTP endpoint will be available at http://127.0.0.1:8080/.

To run the functional tests locally, run `npm run test:functional`.
