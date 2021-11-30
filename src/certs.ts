import { Certificate } from '@relaycorp/relaynet-core';
import { Connection } from 'mongoose';

import { MongoCertificateStore } from './keystores/MongoCertificateStore';
import { Config, ConfigKey } from './utilities/config';

export async function retrieveOwnCertificates(
  connection: Connection,
): Promise<readonly Certificate[]> {
  const store = new MongoCertificateStore(connection);
  const config = new Config(connection);

  const privateAddress = await config.get(ConfigKey.CURRENT_PRIVATE_ADDRESS);
  return store.retrieveAll(privateAddress!!);
}
