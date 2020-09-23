test.todo('Requests with Origin header should be refused');

describe('Handshake', () => {
  test.todo('Challenge should be sent as soon as client connects');

  test.todo('Connection should error out if response is invalid');

  test.todo('Connection should error out if response contains zero signatures');

  test.todo('Connection should error out if response contains at least one invalid signature');

  test.todo('Connection should error out if response contains at least one invalid certificate');

  test.todo('Handshake should complete successfully if all signatures are valid');
});

test.todo('Server should close if there is not Keep-Alive and no parcel to receive');

test.todo('Server should keep connection if Keep-Alive is on');

test.todo('Server should keep connection if Keep-Alive is invalid value');

test.todo('Server should send parcel to deliver');

test.todo('Server should process client parcel acks');

test.todo('Server should tell the client that it cannot accept binary acks');

test.todo('Server should handle gracefully client closes with normal');

test.todo('Server should handle gracefully client closes with another reason besides normal');
