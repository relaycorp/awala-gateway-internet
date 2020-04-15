import { S3 } from 'aws-sdk';
import { get as getEnvVar } from 'env-var';
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
export class ObjectStoreClient {
  public static initFromEnv(): ObjectStoreClient {
    const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT')
      .required()
      .asString();
    const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID')
      .required()
      .asString();
    const secretKey = getEnvVar('OBJECT_STORE_SECRET_KEY')
      .required()
      .asString();
    const tlsEnabled = getEnvVar('OBJECT_STORE_TLS_ENABLED').asBool();
    return new ObjectStoreClient(endpoint, accessKeyId, secretKey, tlsEnabled);
  }

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

  /**
   * Retrieve the keys for all the objects in the specified bucket with the specified key prefix.
   *
   * This will handle pagination if the backend supports it (S3 does, Minio doesn't).
   *
   * @param prefix
   * @param bucket
   */
  public async *listObjectKeys(prefix: string, bucket: string): AsyncIterable<string> {
    // tslint:disable-next-line:no-let
    let continuationToken: string | undefined;
    do {
      const request = this.client.listObjectsV2({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        Prefix: prefix,
      });
      const response = await request.promise();
      for (const objectData of response.Contents as S3.ObjectList) {
        yield objectData.Key as string;
      }

      continuationToken = response.ContinuationToken;
    } while (continuationToken !== undefined);
  }

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
