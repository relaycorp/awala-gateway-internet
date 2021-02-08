/**
 * Maximum number of octets that a RAMF message can span per RS-001.
 *
 * This should not be attempted to be read from the core Relaynet library. Any change to that
 * value should be explicitly reflected here so we can verify that any change won't cause any
 * issues.
 */
export const MAX_RAMF_MESSAGE_SIZE = 9437184;
