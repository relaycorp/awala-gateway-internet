import fastify from 'fastify';
import mongoose, { Connection, ConnectOptions } from 'mongoose';

import { mockSpy } from '../testUtils/jest';

import { FASTIFY_MONGOOSE } from './fastifyMongoose';

const MOCK_MONGOOSE_CONNECTION = { close: mockSpy(jest.fn()) } as any as Connection;
const MOCK_MONGOOSE_CREATE_CONNECTION = mockSpy(
  jest.spyOn(mongoose, 'createConnection'),
  jest.fn().mockReturnValue({ asPromise: () => MOCK_MONGOOSE_CONNECTION }),
);

const MONGO_URI = 'mongo://whatever';

test('Plugin registration should fail if MongoDB URI is missing', async () => {
  const app = fastify();

  await expect(app.register(FASTIFY_MONGOOSE)).rejects.toThrowWithMessage(
    Error,
    'MongoDB URI is missing from fastify-mongoose plugin registration',
  );
});

test('Connection should be established with specified URI', async () => {
  const app = fastify();
  await app.register(FASTIFY_MONGOOSE, { uri: MONGO_URI });

  expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(MONGO_URI, expect.anything());
});

test('Connection options should be honoured if set', async () => {
  const app = fastify();
  const options: ConnectOptions = { bufferCommands: true };
  await app.register(FASTIFY_MONGOOSE, { uri: MONGO_URI, options });

  expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(expect.anything(), options);
});

test('Connection options should be empty by default', async () => {
  const app = fastify();
  await app.register(FASTIFY_MONGOOSE, { uri: MONGO_URI });

  expect(MOCK_MONGOOSE_CREATE_CONNECTION).toBeCalledWith(expect.anything(), {});
});

test('Connection should be added to fastify instance', async () => {
  const app = fastify();
  await app.register(FASTIFY_MONGOOSE, { uri: MONGO_URI });

  expect(app).toHaveProperty('mongoose', MOCK_MONGOOSE_CONNECTION);
});

test('Connection should be closed when fastify ends', async () => {
  const app = fastify();
  await app.register(FASTIFY_MONGOOSE, { uri: MONGO_URI });
  expect(MOCK_MONGOOSE_CONNECTION.close).not.toBeCalled();

  await app.close();

  expect(MOCK_MONGOOSE_CONNECTION.close).toBeCalled();
});
