import { S3 } from 'aws-sdk';
import { get as getEnvVar } from 'env-var';

export async function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1_000));
}

export function initS3Client(): S3 {
  const endpoint = getEnvVar('OBJECT_STORE_ENDPOINT')
    .required()
    .asString();
  const accessKeyId = getEnvVar('OBJECT_STORE_ACCESS_KEY_ID')
    .required()
    .asString();
  const secretAccessKey = getEnvVar('OBJECT_STORE_SECRET_KEY')
    .required()
    .asString();
  return new S3({
    accessKeyId,
    endpoint,
    s3ForcePathStyle: true,
    secretAccessKey,
    signatureVersion: 'v4',
    sslEnabled: false,
  });
}
