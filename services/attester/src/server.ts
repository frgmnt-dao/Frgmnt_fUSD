// Minimal HTTP front for the attester service, on Node's built-in http module (no new packages).
//
//   POST /v1/withdrawal-plan   { "user": "0x..", "fusdAmount": "<wei as decimal string>", "assets": ["0x.."]? }
//   GET  /healthz
//
// Every request must carry `Authorization: Bearer <API key>`. Bind to a private interface and put a
// TLS-terminating proxy in front; the key only stops casual callers, it is not a substitute for
// network isolation. Errors never echo internal detail: a deliberate refusal is a 409 with a
// machine-readable code, anything unexpected is a bare 500.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress } from 'ethers';
import type { AttesterService } from './service';
import { RefusalError, type PlanRequest, type SignedPlan } from './types';

const MAX_BODY_BYTES = 4096;
const MAX_ASSETS = 50;

export interface ServerOptions {
  apiKey: string;
  log?: (message: string) => void;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function authorised(header: string | undefined, apiKey: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  // Equal-length digests, so the comparison time does not depend on where a guess differs.
  return timingSafeEqual(digest(presented), digest(apiKey));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function parseRequest(raw: string): PlanRequest {
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY');
  }
  if (typeof body.user !== 'string' || !isAddress(body.user)) {
    throw new HttpError(400, 'INVALID_USER');
  }
  if (typeof body.fusdAmount !== 'string' || !/^[1-9][0-9]{0,40}$/.test(body.fusdAmount)) {
    throw new HttpError(400, 'INVALID_AMOUNT');
  }
  let assets: string[] | undefined;
  if (body.assets !== undefined) {
    if (
      !Array.isArray(body.assets) ||
      body.assets.length === 0 ||
      body.assets.length > MAX_ASSETS ||
      !body.assets.every((a: unknown) => typeof a === 'string' && isAddress(a))
    ) {
      throw new HttpError(400, 'INVALID_ASSETS');
    }
    assets = body.assets.map((a: string) => getAddress(a));
  }
  return { user: getAddress(body.user), fusdAmount: BigInt(body.fusdAmount), assets };
}

export function serialiseSigned(signed: SignedPlan): unknown {
  return {
    plan: signed.plan,
    signature: signed.signature,
    expiresAt: signed.expiresAt,
    expectedValue: signed.aimValue,
    surchargeAmount: signed.surchargeAmount,
  };
}

export function createAttesterServer(service: AttesterService, options: ServerOptions): Server {
  if (!options.apiKey || options.apiKey.length < 16) {
    throw new Error('an API key of at least 16 characters is required');
  }
  const log = options.log ?? (() => undefined);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return send(res, 200, { ok: true });
      }
      if (!authorised(req.headers.authorization, options.apiKey)) {
        throw new HttpError(401, 'UNAUTHORIZED');
      }
      if (req.method !== 'POST' || req.url !== '/v1/withdrawal-plan') {
        throw new HttpError(404, 'NOT_FOUND');
      }
      const request = parseRequest(await readBody(req));
      const signed = await service.issue(request);
      return send(res, 200, serialiseSigned(signed));
    } catch (e: any) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code });
      if (e instanceof RefusalError) return send(res, 409, { error: e.code, message: e.message });
      // Unexpected: keep the detail in the operator's log, never in the response.
      log(`internal error: ${e?.message ?? e}`);
      return send(res, 500, { error: 'INTERNAL' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
