/* tslint:disable:no-console no-let */
import { connect } from 'node-nats-streaming';
import { promisify } from 'util';

// function main1(): void {
//   const connection = connect('test-cluster', 'publisha');
//
//   connection.on('connect', () => {
//     connection.publish('foo', 'one', (err, guid) => {
//       if (err) {
//         console.log('publish failed: ' + err);
//       } else {
//         console.log('published message with guid: ' + guid);
//       }
//       connection.close();
//     });
//   });
//
//   connection.on('close', () => {
//     process.exit();
//   });
// }

async function mainPromised(payloads: IterableIterator<Buffer>): Promise<void> {
  const connection = connect('test-cluster', 'publisha');

  return new Promise((resolve, reject) => {
    connection.on('connect', async () => {
      const publishPromisified = promisify(connection.publish).bind(connection);
      try {
        for (const payload of payloads) {
          try {
            const guid = await publishPromisified('foo', payload);
            console.log('published message with guid: ' + guid);
          } catch (err) {
            console.log('publish failed: ' + err);
            return reject(err);
          }
        }
      } finally {
        connection.close();
      }
      resolve();
    });

    connection.on('close', () => {
      process.exit();
    });
  });
}

function* makeMessages(): IterableIterator<Buffer> {
  yield Buffer.from('buffer one +' + Math.random());
  yield Buffer.from('buffer two +' + Math.random());
}

mainPromised(makeMessages());

// async function iterableMain(messagePayloads: IterableIterator<string>): Promise<void> {
//   const connection = connect('test-cluster', 'publishaIterable');
//
//   return new Promise(async (resolve, reject) => {
//     connection.on('error', reject);
//
//     connection.on('connect', () => {
//       for (const payload of messagePayloads) {
//         connection.publish('foo', payload, (err, guid) => {
//           if (err) {
//             console.log('publish failed: ', { err, payload });
//             return reject(err);
//           }
//           console.log('published message with guid: ' + guid);
//         });
//       }
//
//       connection.close();
//     });
//   });
// }
