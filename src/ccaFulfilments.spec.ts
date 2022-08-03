import {
  CargoCollectionAuthorization,
  generateRSAKeyPair,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { recordCCAFulfillment, wasCCAFulfilled } from './ccaFulfilments';
import { CCAFulfillment } from './models';
import { mockSpy } from './testUtils/jest';

const MOCK_CONNECTION: Connection = { what: 'the-stub-connection' } as any;
const MOCK_GET_MODEL_FOR_CLASS = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));

let CCA: CargoCollectionAuthorization;
beforeAll(async () => {
  const keyPair = await generateRSAKeyPair();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const senderCertificate = await issueGatewayCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: tomorrow,
  });

  CCA = new CargoCollectionAuthorization({ id: '0deadbeef' }, senderCertificate, Buffer.from([]));
});

describe('wasCCAFulfilled', () => {
  const MOCK_MONGOOSE_EXISTS = mockSpy(jest.fn());
  beforeEach(() =>
    MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ exists: MOCK_MONGOOSE_EXISTS } as any),
  );

  test('Existing connection should be used', async () => {
    await wasCCAFulfilled(CCA, MOCK_CONNECTION);

    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledTimes(1);
    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledWith(CCAFulfillment, {
      existingConnection: MOCK_CONNECTION,
    });
  });

  test('Fulfillments should be filtered by peer address and CCA id', async () => {
    await wasCCAFulfilled(CCA, MOCK_CONNECTION);

    expect(MOCK_MONGOOSE_EXISTS).toBeCalledTimes(1);
    expect(MOCK_MONGOOSE_EXISTS).toBeCalledWith({
      ccaId: CCA.id,
      peerPrivateAddress: await CCA.senderCertificate.calculateSubjectId(),
    });
  });

  test('Unfulfilled CCA should be reported as such', async () => {
    MOCK_MONGOOSE_EXISTS.mockResolvedValue(false);

    const wasFulfilled = await wasCCAFulfilled(CCA, MOCK_CONNECTION);

    expect(wasFulfilled).toBeFalse();
  });

  test('Fulfilled CCA should be reported as such', async () => {
    MOCK_MONGOOSE_EXISTS.mockResolvedValue(true);

    const wasFulfilled = await wasCCAFulfilled(CCA, MOCK_CONNECTION);

    expect(wasFulfilled).toBeTrue();
  });
});

describe('recordCCAFulfillment', () => {
  const MOCK_MONGOOSE_REPLACE_ONE_EXEC = mockSpy(jest.fn());
  const MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS = mockSpy(jest.fn(), () => ({
    exec: MOCK_MONGOOSE_REPLACE_ONE_EXEC,
  }));
  const MOCK_MONGOOSE_REPLACE_ONE = mockSpy(jest.fn(), () => ({
    setOptions: MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS,
  }));
  beforeEach(() =>
    MOCK_GET_MODEL_FOR_CLASS.mockReturnValue({ replaceOne: MOCK_MONGOOSE_REPLACE_ONE } as any),
  );

  test('Existing connection should be used', async () => {
    await recordCCAFulfillment(CCA, MOCK_CONNECTION);

    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledTimes(1);
    expect(MOCK_GET_MODEL_FOR_CLASS).toBeCalledWith(CCAFulfillment, {
      existingConnection: MOCK_CONNECTION,
    });
  });

  test('Fulfillment should be upserted', async () => {
    await recordCCAFulfillment(CCA, MOCK_CONNECTION);

    expect(MOCK_MONGOOSE_REPLACE_ONE).toBeCalledTimes(1);
    const peerPrivateAddress = await CCA.senderCertificate.calculateSubjectId();
    expect(MOCK_MONGOOSE_REPLACE_ONE).toBeCalledWith(
      { peerPrivateAddress, ccaId: CCA.id },
      { peerPrivateAddress, ccaId: CCA.id, ccaExpiryDate: CCA.expiryDate },
    );
    expect(MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS).toBeCalledWith({ upsert: true });
    expect(MOCK_MONGOOSE_REPLACE_ONE_EXEC).toBeCalledTimes(1);
  });
});
