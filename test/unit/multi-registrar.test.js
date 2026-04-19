const test = require('node:test');
const assert = require('node:assert/strict');

const MultiRegistrar = require('../../src/multi-registrar');

test('stop clears pending retry timers', async () => {
  const registrar = new MultiRegistrar({}, {});
  const calls = [];
  registrar.sendRegister = (device, config) => {
    calls.push({ device, config });
  };

  registrar.scheduleRetry({ name: 'ext-1' }, { extension: '1' }, 0.01);
  registrar.stop();

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(calls.length, 0);
  assert.equal(registrar.timers.size, 0);
});

test('registerAll resets stopped state and starts registrations once', () => {
  const requests = [];
  const srf = {
    request(uri, options, callback) {
      requests.push({ uri, options });
      callback(null, { on() {} });
    },
  };
  const registrar = new MultiRegistrar(srf, {
    domain: 'example.com',
    registrar: '127.0.0.1',
    registrar_port: 5060,
    expiry: 60,
    local_address: '127.0.0.1',
    local_port: 5070,
  });

  registrar.stop();
  registrar.registerAll({
    '12611': {
      name: 'ext-12611',
      extension: '12611',
      authId: '12611',
      password: 'secret',
    },
  });

  assert.equal(registrar.stopped, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'REGISTER');
});
