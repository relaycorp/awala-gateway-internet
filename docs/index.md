---
title: Home
---
# Relaynet-Internet Gateway

The Relaynet-Internet Gateway is a cloud-native, server-side application that acts as a Relaynet _Internet gateway_ that connects private gateways to the Internet as well as each other.

This documentation is aimed at people contributing to the development of this app, and organisations operating an instance of this app.

By default, private gateways (e.g., the Android gateway) will connect to an instance of this app operated by [Relaycorp](https://relaycorp.tech/), which means that neither users nor service providers _have_ to deploy their own instance -- in fact, both stakeholders are encouraged not to do that anyway:

- Unless the Internet gateway is shared with many users, it'd be relatively easy for an observer to identify the user. This is analogous to email addresses: If you have an email address at a domain that only you or very few people use, then an outsider could infer who you are -- Which wouldn't happen if you use a widely-used domain like `gmail.com`.
- Relaynet service providers need not be concerned about the Internet gateways of their users, just like Web site operators need not be concerned about the Internet Service Providers (ISPs) of their users.

If you decide to operate a Internet gateway, whether this implementation or one provided by another party, you are strongly encouraged to familiarise yourself with the [Relaynet bindings](https://specs.relaynet.network/RS-000#message-transport-bindings) supported by the gateway. Otherwise, it would be very hard for you to configure it properly or triage issues.
