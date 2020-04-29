// tslint:disable:no-let

import {
  CargoCollectionAuthorization,
  generateRSAKeyPair,
  issueGatewayCertificate,
} from '@relaycorp/relaynet-core';
import * as typegoose from '@typegoose/typegoose';
import { Connection } from 'mongoose';

import { mockSpy } from '../_test_utils';
import { recordCCAFulfillment, wasCCAFulfilled } from './ccaFulfilments';
import { CCAFulfillment } from './models';

const STUB_CONNECTION: Connection = { what: 'the-stub-connection' } as any;
const stubGetModelForClass = mockSpy(jest.spyOn(typegoose, 'getModelForClass'));

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

  CCA = new CargoCollectionAuthorization('0deadbeef', senderCertificate, Buffer.from([]));
});

describe('wasCCAFulfilled', () => {
  const MOCK_MONGOOSE_EXISTS = mockSpy(jest.fn());
  beforeEach(() => stubGetModelForClass.mockReturnValue({ exists: MOCK_MONGOOSE_EXISTS }));

  test('Existing connection should be used', async () => {
    await wasCCAFulfilled(CCA, STUB_CONNECTION);

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(CCAFulfillment, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Fulfillments should be filtered by peer address and CCA id', async () => {
    await wasCCAFulfilled(CCA, STUB_CONNECTION);

    expect(MOCK_MONGOOSE_EXISTS).toBeCalledTimes(1);
    expect(MOCK_MONGOOSE_EXISTS).toBeCalledWith({
      ccaId: CCA.id,
      peerPrivateAddress: await CCA.senderCertificate.calculateSubjectPrivateAddress(),
    });
  });

  test('Unfulfilled CCA should be reported as such', async () => {
    MOCK_MONGOOSE_EXISTS.mockResolvedValue(false);

    const wasFulfilled = await wasCCAFulfilled(CCA, STUB_CONNECTION);

    expect(wasFulfilled).toBeFalse();
  });

  test('Fulfilled CCA should be reported as such', async () => {
    MOCK_MONGOOSE_EXISTS.mockResolvedValue(true);

    const wasFulfilled = await wasCCAFulfilled(CCA, STUB_CONNECTION);

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
  beforeEach(() => stubGetModelForClass.mockReturnValue({ replaceOne: MOCK_MONGOOSE_REPLACE_ONE }));

  test('Existing connection should be used', async () => {
    await recordCCAFulfillment(CCA, STUB_CONNECTION);

    expect(stubGetModelForClass).toBeCalledTimes(1);
    expect(stubGetModelForClass).toBeCalledWith(CCAFulfillment, {
      existingConnection: STUB_CONNECTION,
    });
  });

  test('Fulfillment should be upserted', async () => {
    await recordCCAFulfillment(CCA, STUB_CONNECTION);

    expect(MOCK_MONGOOSE_REPLACE_ONE).toBeCalledTimes(1);
    const peerPrivateAddress = await CCA.senderCertificate.calculateSubjectPrivateAddress();
    expect(MOCK_MONGOOSE_REPLACE_ONE).toBeCalledWith(
      { peerPrivateAddress, ccaId: CCA.id },
      { peerPrivateAddress, ccaId: CCA.id, ccaExpiryDate: CCA.expiryDate },
    );
    expect(MOCK_MONGOOSE_REPLACE_ONE_SET_OPTIONS).toBeCalledWith({ upsert: true });
    expect(MOCK_MONGOOSE_REPLACE_ONE_EXEC).toBeCalledTimes(1);
  });
});
