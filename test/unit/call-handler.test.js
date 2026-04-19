const test = require('node:test');
const assert = require('node:assert/strict');

const CallHandler = require('../../src/call-handler');

test('makeOutboundCall uses SBC proxy auth and connects media after answer', async (t) => {
  const originalEnv = {
    SIP_DOMAIN: process.env.SIP_DOMAIN,
    SIP_REGISTRAR: process.env.SIP_REGISTRAR,
    SIP_REGISTRAR_PORT: process.env.SIP_REGISTRAR_PORT,
    SIP_AUTH_ID: process.env.SIP_AUTH_ID,
    SIP_AUTH_USERNAME: process.env.SIP_AUTH_USERNAME,
    SIP_AUTH_PASSWORD: process.env.SIP_AUTH_PASSWORD,
    SIP_PASSWORD: process.env.SIP_PASSWORD,
    SIP_OUTBOUND_PROXY: process.env.SIP_OUTBOUND_PROXY,
  };

  process.env.SIP_DOMAIN = '1664.3cx.cloud';
  process.env.SIP_REGISTRAR = '127.0.0.1';
  process.env.SIP_REGISTRAR_PORT = '5060';
  process.env.SIP_AUTH_ID = 'lukybot12611';
  process.env.SIP_AUTH_PASSWORD = 'secret';
  delete process.env.SIP_OUTBOUND_PROXY;
  t.after(() => {
    Object.assign(process.env, originalEnv);
  });

  const endpoint = {
    local: { sdp: 'local-sdp' },
    modifyCalls: [],
    destroyCalls: 0,
    async modify(sdp) {
      this.modifyCalls.push(sdp);
    },
    async destroy() {
      this.destroyCalls += 1;
    },
  };

  let captured = null;
  const sipDialog = {
    remote: { sdp: 'remote-sdp' },
    handlers: {},
    on(event, handler) {
      this.handlers[event] = handler;
    },
  };

  const srf = {
    async createUAC(target, options, callbacks) {
      captured = { target, options, callbacks };
      return sipDialog;
    },
  };

  const handler = new CallHandler(
    srf,
    {},
    {},
    {},
    { unregister() {} },
    { audioDir: '/tmp', audioPort: 3101 }
  );

  handler.setMediaServer({
    async createEndpoint() {
      return endpoint;
    },
  });

  const result = await handler.makeOutboundCall('sip:12610@1664.3cx.cloud', '12611');

  assert.equal(result.endpoint, endpoint);
  assert.equal(result.dialog, sipDialog);
  assert.equal(captured.target, 'sip:12610@1664.3cx.cloud;transport=udp');
  assert.equal(captured.options.proxy, 'sip:127.0.0.1:5060;transport=udp');
  assert.equal(captured.options.localSdp, 'local-sdp');
  assert.deepEqual(captured.options.auth, {
    username: 'lukybot12611',
    password: 'secret',
  });
  assert.equal(captured.options.localSipUri, 'sip:12611@1664.3cx.cloud');
  assert.deepEqual(endpoint.modifyCalls, ['remote-sdp']);
  assert.equal(typeof captured.callbacks.cbProvisional, 'function');

});
