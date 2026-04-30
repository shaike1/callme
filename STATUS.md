# CallMe + Drachtio + 3CX Status

**Date:** 2026-04-20  
**Location:** `/root/ocplatform-3cx`

## ✅ Working Components

1. **Drachtio SIP Server** — Built for ARM64, running in container
2. **FreeSWITCH Media Server** — Running, connected
3. **CallMe Voice Bot** — Running, all services initialized
4. **Docker Networking** — Bridge network, port forwarding configured
5. **SIP REGISTER** — Sending correctly to 3CX with proper credentials

## 📊 Current Status

```
Container Status: 3/3 running (drachtio, freeswitch, callme)
Drachtio: ✅ Listening on 0.0.0.0:9022 (admin), 0.0.0.0:5060 (SIP UDP)
FreeSWITCH: ✅ Event Socket on 8021
CallMe: ✅ Connected to Drachtio + FreeSWITCH
```

## 📝 SIP Registration Details

```
Extension: 12611
Auth ID: 12610
Password: 3cx!3Cx!3CX
Domain: 1664.3cx.cloud
Contact: sip:12611@129.159.153.133:5060
```

**REGISTER packet sent:** ✅  
**3CX response:** ❌ 408 Request Timeout

## 🚧 Blocking Issue

**OCI Security Rules** — Incoming UDP 5060 still blocked

### Required OCI Configuration:

#### Ingress Rule:
```
Stateless: Yes
Source CIDR: 0.0.0.0/0
IP Protocol: UDP
Destination Port Range: 5060
```

#### Egress Rule (if not exists):
```
Stateless: Yes
Destination CIDR: 0.0.0.0/0
IP Protocol: UDP
Destination Port Range: 5060
```

### How to Check:

1. **OCI Console** → Networking → Virtual Cloud Networks
2. Find the VCN attached to instance (`vps`, IP: `10.0.0.115`)
3. Check **Security Lists** of the subnet
4. Check **Network Security Groups** (if any attached)
5. Verify rule is in correct subnet (same as instance)

## 📁 Files

- `docker-compose.yml` — Service definitions
- `drachtio.conf.xml` — Drachtio config
- `.env` — Environment variables
- `src/index.js` — CallMe main entry point

## 🔍 Testing

```bash
# Check if SIP port is open from container
docker exec callme-voice-bot nc -zv -u 1664.3cx.cloud 5060

# Watch SIP traffic (requires tcpdump)
tcpdump -i any -n port 5060

# Check container logs
docker logs callme-voice-bot --tail 20
docker logs drachtio-server --tail 20

# Restart everything
cd /root/ocplatform-3cx
docker-compose down && docker-compose up -d
```

## 🎯 Next Steps

1. **Verify OCI Security Rules are active** (may take 1-2 minutes to apply)
2. **Check 3CX admin panel** — Extensions → 12611 → Options → Allow remote registration
3. **Test with tcpdump** to see if packets arrive
4. If still failing: Contact 3CX support to verify firewall/geo-blocking

## 💡 Alternative Solutions

If OCI rules don't work:
- Use **3CX WebRTC** API instead of SIP (no firewall issues)
- Use **VPN/Tailscale** to create secure tunnel
- Use **Cloudflare Spectrum** for UDP proxy
