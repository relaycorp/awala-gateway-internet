import fastify from 'fastify';
import type { Connection } from 'mongoose';

import { mockSpy } from '../../testUtils/jest';

const mockMongooseClose = mockSpy(jest.fn());
const mockMongoose = { close: mockMongooseClose } as unknown as Connection;
jest.mock('../../backingServices/mongo', () => ({
  createMongooseConnectionFromEnv: jest.fn().mockReturnValue(mockMongoose),
}));
import fastifyMongoose from './fastifyMongoose';

describe('fastifyMongoose', () => {
  test('Connection should be added to fastify instance', async () => {
    const app = fastify();
    await app.register(fastifyMongoose);

    expect(app).toHaveProperty('mongoose');

    expect(app.mongoose).toStrictEqual(mockMongoose);
  });

  test('Connection should be closed when fastify ends', async () => {
    const app = fastify();
    await app.register(fastifyMongoose);
    expect(mockMongooseClose).not.toHaveBeenCalled();

    await app.close();

    expect(mockMongooseClose).toHaveBeenCalledWith();
  });
});
