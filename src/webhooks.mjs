import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createHmac } from 'node:crypto';
import { fault } from './store.mjs';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]])
  blocked.addSubnet(ip, bits, 'ipv4');
const v6 = new BlockList(); v6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
export const publicAddress = ip => isIP(ip) === 4 ? !blocked.check(ip, 'ipv4')
  : isIP(ip) === 6 && v6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');

export function callbackUrl(value) {
  let url; try { url = new URL(value); } catch { throw fault('invalid_callback', 'Invalid callback URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443'))
    throw fault('invalid_callback', 'A public HTTPS callback on port 443 is required.');
  return url;
}
export function secretKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw fault('invalid_secret', 'Expected a Standard Webhooks signing key.');
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== secret.slice(6).replace(/=+$/, ''))
    throw fault('invalid_secret', 'Signing keys must encode 24–64 bytes.');
  return key;
}
export function signedHeaders(subscription, id, body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  const secrets = [subscription.secret, ...(subscription.previousSecret && subscription.rotateUntil > now ? [subscription.previousSecret] : [])];
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': secrets.map(secret => `v1,${createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`).join(' '),
    'X-MCP-Subscription-Id': subscription.id };
}

/** Resolve at each connection, pin the validated address, and retain hostname TLS verification. */
export async function postWebhook(subscription, id, body) {
  if (Buffer.byteLength(body) > 256 * 1024) throw fault('payload_too_large', 'Webhook exceeds 256 KiB.');
  const url = callbackUrl(subscription.url);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw fault('invalid_callback', 'Callback resolved to a non-public address.');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, signal: AbortSignal.timeout(10_000),
      headers: signedHeaders(subscription, id, body),
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) response.destroy(new Error('Callback response exceeds 16 KiB.')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
