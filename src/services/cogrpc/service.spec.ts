import { CargoDelivery, CargoDeliveryAck } from '@relaycorp/relaynet-cogrpc';
import { ServerDuplexStream } from 'grpc';

import { collectCargo, deliverCargo } from './service';

describe('service', () => {
  describe('deliverCargo', () => {
    test('Unimplemented', () => {
      expect(() =>
        deliverCargo((null as unknown) as ServerDuplexStream<CargoDelivery, CargoDeliveryAck>),
      ).toThrowWithMessage(Error, 'Unimplemented');
    });
  });

  describe('collectCargo', () => {
    test('Unimplemented', async () => {
      await expect(
        collectCargo((null as unknown) as ServerDuplexStream<CargoDeliveryAck, CargoDelivery>),
      ).rejects.toEqual(new Error('Unimplemented'));
    });
  });
});
