import * as http from 'http';
import * as https from 'https';

import { getMockContext, mockSpy } from '../services/_test_utils';

const mockS3Client = {
  putObject: mockSpy(jest.fn(), () => ({ promise: () => Promise.resolve() })),
};
jest.mock('aws-sdk', () => ({
  S3: jest.fn().mockReturnValue(mockS3Client),
}));
import * as AWS from 'aws-sdk';
import { ObjectStore, StoreObject } from './objectStorage';

const SECRET_ACCESS_KEY = 'secret-access-key';
const ACCESS_KEY = 'the-access-key';
const ENDPOINT = 'the-endpoint';

const BUCKET = 'the-bucket';
const OBJECT_KEY = 'the-object.txt';
const OBJECT: StoreObject = { body: Buffer.from('the-body'), metadata: { foo: 'bar' } };

describe('ObjectStore', () => {
  describe('Constructor', () => {
    describe('Client', () => {
      test('Specified endpoint should be used', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('endpoint', ENDPOINT);
      });

      test('Specified credentials should be used', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('accessKeyId', ACCESS_KEY);
        expect(s3CallArgs).toHaveProperty('secretAccessKey', SECRET_ACCESS_KEY);
      });

      test('Signature should use version 4', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('signatureVersion', 'v4');
      });

      test('s3ForcePathStyle should be enabled', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('s3ForcePathStyle', true);
      });

      test('TSL should be enabled by default', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('sslEnabled', true);
      });

      test('TSL may be disabled', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, false);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('sslEnabled', false);
      });

      describe('HTTP(S) agent', () => {
        test('HTTP agent with Keep-Alive should be used when TSL is disabled', () => {
          // tslint:disable-next-line:no-unused-expression
          new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, false);

          expect(AWS.S3).toBeCalledTimes(1);

          const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
          const agent = s3CallArgs.httpOptions.agent;
          expect(agent).toBeInstanceOf(http.Agent);
          expect(agent).toHaveProperty('keepAlive', true);
        });

        test('HTTPS agent with Keep-Alive should be used when TSL is enabled', () => {
          // tslint:disable-next-line:no-unused-expression
          new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, true);

          expect(AWS.S3).toBeCalledTimes(1);

          const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
          const agent = s3CallArgs.httpOptions.agent;
          expect(agent).toBeInstanceOf(https.Agent);
          expect(agent).toHaveProperty('keepAlive', true);
        });
      });
    });
  });

  describe('putObject', () => {
    const client = new ObjectStore(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

    test('Object should be created with specified parameters', async () => {
      await client.putObject(OBJECT, OBJECT_KEY, BUCKET);

      expect(mockS3Client.putObject).toBeCalledTimes(1);
      expect(mockS3Client.putObject).toBeCalledWith({
        Body: OBJECT.body,
        Bucket: BUCKET,
        Key: OBJECT_KEY,
        Metadata: OBJECT.metadata,
      });
    });
  });
});
