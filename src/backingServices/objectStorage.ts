import { S3 } from 'aws-sdk';
import * as http from 'http';
import * as https from 'https';

export interface StoreObject {
  readonly metadata: { readonly [key: string]: string };
  readonly body: Buffer;
}

/**
 * Thin wrapper around S3-compatible object storage library.
 *
 * This is meant to make it easy to change the underlying library in the future, as we may want to
 * use something like https://github.com/ItalyPaleAle/SMCloudStore. This approach should also make
 * it a little easier to support other authentication mechanisms, like service accounts.
 */
export class ObjectStore {
  protected readonly client: S3;

  constructor(endpoint: string, accessKeyId: string, secretAccessKey: string, tlsEnabled = true) {
    const agentOptions = { keepAlive: true };
    const agent = tlsEnabled ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    this.client = new S3({
      accessKeyId,
      endpoint,
      httpOptions: { agent },
      s3ForcePathStyle: true,
      secretAccessKey,
      signatureVersion: 'v4',
      sslEnabled: tlsEnabled,
    });
  }

  // public async getObject(key: string, bucket: string): Promise<StoreObject> {
  //   const data = await this.client.getObject({ Bucket: bucket, Key: key }).promise();
  //   return { body: data.Body as Buffer, metadata: data.Metadata || {} };
  // }

  public async putObject(object: StoreObject, key: string, bucket: string): Promise<void> {
    const request = this.client.putObject({
      Body: object.body,
      Bucket: bucket,
      Key: key,
      Metadata: object.metadata,
    });
    await request.promise();
  }

  // public async deleteObject(key: string, bucket: string): Promise<void> {
  //   await this.client.deleteObject({ Key: key, Bucket: bucket }).promise();
  // }
}
