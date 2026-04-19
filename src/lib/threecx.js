const https = require('https');
const http = require('http');

const agent = new https.Agent({ rejectUnauthorized: false });

class ThreeCXClient {
  constructor(env) {
    this.host = env.THREECX_HOST || '1664.3cx.cloud';
    this.user = env.THREECX_USER || '12610';
    this.password = env.THREECX_PASSWORD || '3cx!3Cx!3CX';
    this.extension = env.THREECX_EXTENSION || '9000';
    this._token = env.THREECX_API_TOKEN || '';
    this._base = '/xapi/v1';
  }

  async _getToken() {
    const attempts = [
      `grant_type=password&client_id=WebClient&username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.password)}&scope=openid+profile+offline_access`,
      `grant_type=password&client_id=WebClient&username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.password)}`,
      `grant_type=password&client_id=PhoneApp&username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.password)}`,
    ];
    for (const body of attempts) {
      try {
        const data = await this._raw('POST', '/connect/token', body, 'application/x-www-form-urlencoded');
        if (data && data.access_token) {
          this._token = data.access_token;
          return this._token;
        }
      } catch {}
    }
    return null;
  }

  _authHeader() {
    if (this._token) return `Bearer ${this._token}`;
    const creds = Buffer.from(`${this.user}:${this.password}`).toString('base64');
    return `Basic ${creds}`;
  }

  _raw(method, path, body, contentType) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.host,
        port: 443,
        path,
        method,
        agent,
        headers: {
          'Accept': 'application/json',
          'Content-Type': contentType || 'application/json',
          'Authorization': this._authHeader(),
        },
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ status: res.statusCode, raw: raw.slice(0, 200) }); }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async _request(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: this.host,
      port: 443,
      path: this._base + path,
      method,
      agent,
      headers: {
        'Accept': 'application/json',
        'Authorization': this._authHeader(),
      },
    };
    if (bodyStr) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const doRequest = () => new Promise((resolve, reject) => {
      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode === 401) {
            resolve({ __status: 401 });
            return;
          }
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ status: res.statusCode, raw: raw.slice(0, 200) }); }
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });

    let result = await doRequest();
    if (result && result.__status === 401 && !this._token) {
      await this._getToken();
      opts.headers['Authorization'] = this._authHeader();
      result = await doRequest();
    }
    return result;
  }

  getActiveCalls() { return this._request('GET', '/ActiveCalls'); }
  makeCall(destination, audioUrl) {
    return this._request('POST', '/Users/Pbx.MakeCall', {
      toNumber: destination,
      fromNumber: this.extension,
      ...(audioUrl ? { contact: audioUrl } : {}),
    });
  }
  hangupCall(id) { return this._request('POST', `/ActiveCalls(${id})/Pbx.DropCall`); }
}

module.exports = { ThreeCXClient };
