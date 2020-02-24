/* tslint:disable:no-console no-let */

// import { connect } from 'node-nats-streaming';
//
// function main(clientName: string): void {
//     const connection = connect('test-cluster', clientName);
//     connection.on('connect', () => {
//         // Subscriber can specify how many existing messages to get.
//         const opts = connection
//             .subscriptionOptions()
//             .setDurableName('durableName')
//             .setDeliverAllAvailable()
//             .setManualAckMode(true)
//             .setAckWait(5_000)
//             .setMaxInFlight(1);
//         const subscription = connection.subscribe('foo', 'queue', opts);
//         subscription.on('message', msg => {
//             msg.ack();
//             console.log('Received a message [' + msg.getSequence() + '] ' + msg.getRawData(), {
//                 clientName,
//             });
//         });
//
//         // After one second, unsubscribe, when that is done, close the connection
//         setTimeout(() => {
//             subscription.unsubscribe();
//             subscription.on('unsubscribed', () => {
//                 connection.close();
//             });
//         }, 30000);
//     });
// }

import { PassThrough } from 'stream';
// @ts-ignore
import streamToIt = require('stream-to-it');
import { NatsStreamingClient } from './services/natsStreaming';

async function main(clientName: string): Promise<void> {
  const client = new NatsStreamingClient('nats://127.0.0.1:4222', 'test-cluster', clientName);
  const connection = await client.connect();

  const sourceStream = new PassThrough({ objectMode: true });
  // Subscriber can specify how many existing messages to get.
  const opts = connection
    .subscriptionOptions()
    .setDurableName('durableName')
    .setDeliverAllAvailable()
    .setManualAckMode(true)
    .setAckWait(5_000)
    .setMaxInFlight(1);
  const subscription = connection.subscribe('foo', 'queue', opts);
  subscription.on('message', msg => sourceStream.write(msg));

  // After a few seconds, unsubscribe, when that is done, close the connection
  setTimeout(() => {
    connection.close();
  }, 3_000);
  process.on('SIGINT', () => console.log('Inside SIGINT handler'));
  process.on('beforeExit', () => console.log('Inside beforeExit handler'));
  process.on('exit', () => console.log('Inside exit handler'));

  console.log('About to start loop');
  try {
    for await (const msg of streamToIt.source(sourceStream)) {
      msg.ack();
      console.log('Received a message [' + msg.getSequence() + '] ' + msg.getRawData(), {
        clientName,
      });
    }
  } finally {
    console.log('Inside finally');
  }
}

main('c1');
main('c2');
