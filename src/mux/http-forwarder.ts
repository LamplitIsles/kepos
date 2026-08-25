import b4a from "b4a";
import {
  Transform,
  type Duplex,
  type TransformCallback,
} from "node:stream";

export const maximumHttpRequestHeadBytes = 16 * 1024;
const maximumWebSocketPendingBytes = maximumHttpRequestHeadBytes;

const requestHeadTerminator = b4a.from("\r\n\r\n", "latin1");
const crlf = b4a.from("\r\n", "latin1");
const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const publicKeyPattern = /^[0-9a-f]{64}$/;
const maximumHttpChunkLineBytes = maximumHttpRequestHeadBytes;

type RequestState =
  | "head"
  | "content-length"
  | "chunk-size"
  | "chunk-data"
  | "chunk-data-crlf"
  | "chunk-trailers"
  | "websocket-pending"
  | "websocket-opaque";

export interface HttpRequestForwarderOptions {
  onWebSocketUpgrade?: () => void;
}

export interface HttpRequestForwarder extends Transform {
  releaseWebSocketUpgrade: (opaque: boolean) => void;
}

/**
 * Incrementally authenticate and forward a persistent HTTP/1.1 request
 * stream. Only request metadata is buffered; declared bodies are emitted as
 * soon as their framing has been validated.
 */
export function createHttpRequestForwarder(
  subscriberPublicKey: string,
  options: HttpRequestForwarderOptions = {},
): HttpRequestForwarder {
  validateSubscriberPublicKey(subscriberPublicKey);

  let state: RequestState = "head";
  let headBuffer = b4a.alloc(0);
  let contentLengthRemaining = 0;
  let chunkRemaining = 0;
  let chunkSizeLine: number[] = [];
  let chunkSizeLineSawCr = false;
  let chunkDataCrlfProgress = 0;
  let chunkZeroLine: Uint8Array | undefined;
  let trailerLine: number[] = [];
  let trailerLineSawCr = false;
  let trailerLines: Uint8Array[] = [];
  let trailerBytes = 0;
  let completedRequests = 0;
  let websocketAttempted = false;
  let websocketPendingBytes = b4a.alloc(0);
  let failure: Error | undefined;

  let forwarder!: HttpRequestForwarder;
  forwarder = new Transform({
    transform(chunk: Uint8Array, _encoding: BufferEncoding, callback) {
      if (failure) {
        callback(failure);
        return;
      }

      const output: Uint8Array[] = [];
      try {
        consumeInput(b4a.from(chunk), output);
      } catch (error) {
        const normalized = toError(error);
        failure = normalized;
        const forwarded = combineOutput(output);
        if (forwarded) {
          callback(null, forwarded);
          queueMicrotask(() => {
            if (!forwarder.destroyed) forwarder.destroy(normalized);
          });
        } else {
          callback(normalized);
        }
        return;
      }

      callback(null, combineOutput(output));
    },
    flush(callback: TransformCallback) {
      try {
        if (state === "websocket-opaque") {
          callback();
          return;
        }
        if (state === "websocket-pending") {
          throw new Error(
            "WebSocket request ended before its target handshake response",
          );
        }
        if (state !== "head") {
          throw new Error("HTTP request ended before its declared body completed");
        }
        if (headBuffer.byteLength > 0) {
          throw new Error("HTTP request ended before a complete request head");
        }
        if (completedRequests === 0) {
          throw new Error("HTTP request ended before a complete request head");
        }
        callback();
      } catch (error) {
        const normalized = toError(error);
        failure = normalized;
        callback(normalized);
      }
    },
  }) as HttpRequestForwarder;
  forwarder.releaseWebSocketUpgrade = releaseWebSocketUpgrade;
  return forwarder;

  function consumeInput(input: Uint8Array, output: Uint8Array[]): void {
    let offset = 0;
    while (offset < input.byteLength) {
      if (state === "head") {
        const parsed = consumeRequestHead(input, offset);
        if (!parsed) return;
        offset = parsed.offset;
        if (parsed.websocket) {
          if (completedRequests !== 0 || websocketAttempted) {
            throw new Error(
              "WebSocket Upgrade requires a fresh HTTP service tunnel",
            );
          }
          options.onWebSocketUpgrade?.();
          websocketAttempted = true;
          state = "websocket-pending";
          output.push(parsed.head);
          continue;
        } else if (parsed.chunked) {
          output.push(parsed.head);
          beginChunkedBody();
        } else if (parsed.contentLength === undefined || parsed.contentLength === 0) {
          output.push(parsed.head);
          completeRequest();
        } else {
          output.push(parsed.head);
          state = "content-length";
          contentLengthRemaining = parsed.contentLength;
        }
        continue;
      }

      if (state === "websocket-pending") {
        holdWebSocketBytes(input.subarray(offset));
        return;
      }

      if (state === "websocket-opaque") {
        output.push(input.subarray(offset));
        return;
      }

      if (state === "content-length") {
        const take = Math.min(
          contentLengthRemaining,
          input.byteLength - offset,
        );
        if (take > 0) {
          output.push(input.subarray(offset, offset + take));
          offset += take;
          contentLengthRemaining -= take;
        }
        if (contentLengthRemaining === 0) completeRequest();
        continue;
      }

      if (state === "chunk-size") {
        consumeChunkSizeByte(input[offset++], output);
        continue;
      }

      if (state === "chunk-data") {
        const take = Math.min(chunkRemaining, input.byteLength - offset);
        if (take > 0) {
          output.push(input.subarray(offset, offset + take));
          offset += take;
          chunkRemaining -= take;
        }
        if (chunkRemaining === 0) {
          state = "chunk-data-crlf";
          chunkDataCrlfProgress = 0;
        }
        continue;
      }

      if (state === "chunk-data-crlf") {
        consumeChunkDataCrlfByte(input[offset++], output);
        continue;
      }

      consumeTrailerByte(input[offset++], output);
    }
  }

  function holdWebSocketBytes(input: Uint8Array): void {
    if (input.byteLength === 0) return;
    const size = websocketPendingBytes.byteLength + input.byteLength;
    if (size > maximumWebSocketPendingBytes) {
      throw new Error(
        `WebSocket post-handshake bytes exceed ${maximumWebSocketPendingBytes} bytes before the target response`,
      );
    }
    websocketPendingBytes = b4a.concat([websocketPendingBytes, input]);
  }

  function releaseWebSocketUpgrade(opaque: boolean): void {
    if (state !== "websocket-pending" || forwarder.destroyed) return;
    const held = websocketPendingBytes;
    websocketPendingBytes = b4a.alloc(0);
    if (opaque) {
      state = "websocket-opaque";
      if (held.byteLength > 0) forwarder.push(held);
      return;
    }

    state = "head";
    if (held.byteLength === 0) return;
    const output: Uint8Array[] = [];
    try {
      consumeInput(held, output);
      const forwarded = combineOutput(output);
      if (forwarded) forwarder.push(forwarded);
    } catch (error) {
      const normalized = toError(error);
      failure = normalized;
      forwarder.destroy(normalized);
    }
  }

  function consumeRequestHead(
    input: Uint8Array,
    start: number,
  ): {
    offset: number;
    head: Uint8Array;
    contentLength?: number;
    chunked?: boolean;
    websocket?: boolean;
  } | undefined {
    let offset = start;
    while (true) {
      const headerEnd = b4a.indexOf(headBuffer, requestHeadTerminator);
      if (headerEnd !== -1) {
        const headLength = headerEnd + requestHeadTerminator.byteLength;
        if (headLength > maximumHttpRequestHeadBytes) {
          throw new Error(
            `HTTP request head exceeds ${maximumHttpRequestHeadBytes} bytes`,
          );
        }
        const parsed = parseHttpRequestHead(
          headBuffer.subarray(0, headLength),
          subscriberPublicKey,
        );
        headBuffer = b4a.alloc(0);
        return {
          offset,
          head: parsed.head,
          ...(parsed.contentLength === undefined
            ? {}
            : { contentLength: parsed.contentLength }),
          ...(parsed.chunked ? { chunked: true } : {}),
          ...(parsed.websocket ? { websocket: true } : {}),
        };
      }

      if (headBuffer.byteLength >= maximumHttpRequestHeadBytes) {
        throw new Error(
          `HTTP request head exceeds ${maximumHttpRequestHeadBytes} bytes`,
        );
      }
      if (offset >= input.byteLength) return undefined;

      const capacity = maximumHttpRequestHeadBytes - headBuffer.byteLength;
      const take = Math.min(capacity, input.byteLength - offset);
      const candidate = b4a.concat([
        headBuffer,
        input.subarray(offset, offset + take),
      ]);
      const candidateEnd = b4a.indexOf(candidate, requestHeadTerminator);
      if (candidateEnd === -1) {
        headBuffer = candidate;
        offset += take;
        continue;
      }

      const headLength = candidateEnd + requestHeadTerminator.byteLength;
      if (headLength > maximumHttpRequestHeadBytes) {
        throw new Error(
          `HTTP request head exceeds ${maximumHttpRequestHeadBytes} bytes`,
        );
      }
      const parsed = parseHttpRequestHead(
        candidate.subarray(0, headLength),
        subscriberPublicKey,
      );
      const consumed = headLength - headBuffer.byteLength;
      headBuffer = b4a.alloc(0);
      return {
        offset: offset + consumed,
        head: parsed.head,
        ...(parsed.contentLength === undefined
          ? {}
          : { contentLength: parsed.contentLength }),
        ...(parsed.chunked ? { chunked: true } : {}),
        ...(parsed.websocket ? { websocket: true } : {}),
      };
    }
  }

  function beginChunkedBody(): void {
    state = "chunk-size";
    chunkRemaining = 0;
    chunkSizeLine = [];
    chunkSizeLineSawCr = false;
    chunkDataCrlfProgress = 0;
    chunkZeroLine = undefined;
    trailerLine = [];
    trailerLineSawCr = false;
    trailerLines = [];
    trailerBytes = 0;
  }

  function consumeChunkSizeByte(byte: number, output: Uint8Array[]): void {
    if (chunkSizeLineSawCr) {
      if (byte !== 0x0a) {
        throw new Error("HTTP chunk-size line is not CRLF terminated");
      }
      const line = b4a.from(chunkSizeLine);
      const size = parseChunkSizeLine(line);
      const wireLine = b4a.concat([line, crlf]);
      chunkSizeLine = [];
      chunkSizeLineSawCr = false;
      if (size === 0) {
        chunkZeroLine = wireLine;
        trailerBytes = wireLine.byteLength + crlf.byteLength;
        if (trailerBytes > maximumHttpChunkLineBytes) {
          throw new Error("HTTP chunk trailers exceed the bounded limit");
        }
        state = "chunk-trailers";
      } else {
        output.push(wireLine);
        chunkRemaining = size;
        state = "chunk-data";
      }
      return;
    }

    if (byte === 0x0d) {
      chunkSizeLineSawCr = true;
      return;
    }
    if (byte === 0x0a) {
      throw new Error("HTTP chunk-size line contains a bare LF");
    }
    chunkSizeLine.push(byte);
    if (chunkSizeLine.length > maximumHttpChunkLineBytes) {
      throw new Error("HTTP chunk-size line exceeds the bounded limit");
    }
  }

  function consumeChunkDataCrlfByte(byte: number, output: Uint8Array[]): void {
    const expected = chunkDataCrlfProgress === 0 ? 0x0d : 0x0a;
    if (byte !== expected) {
      throw new Error("HTTP chunk data is not followed by CRLF");
    }
    chunkDataCrlfProgress++;
    if (chunkDataCrlfProgress === crlf.byteLength) {
      output.push(crlf);
      chunkDataCrlfProgress = 0;
      state = "chunk-size";
    }
  }

  function consumeTrailerByte(byte: number, output: Uint8Array[]): void {
    if (trailerLineSawCr) {
      if (byte !== 0x0a) {
        throw new Error("HTTP chunk trailer is not CRLF terminated");
      }
      const line = b4a.from(trailerLine);
      trailerLine = [];
      trailerLineSawCr = false;
      if (line.byteLength === 0) {
        if (!chunkZeroLine) {
          throw new Error("HTTP chunk trailer is missing its zero chunk");
        }
        const pieces: Uint8Array[] = [chunkZeroLine];
        for (const trailer of trailerLines) pieces.push(trailer, crlf);
        pieces.push(crlf);
        output.push(b4a.concat(pieces));
        completeRequest();
        chunkZeroLine = undefined;
        trailerLines = [];
        trailerBytes = 0;
      } else if (parseTrailerLine(line)) {
        trailerBytes += line.byteLength + crlf.byteLength;
        if (trailerBytes + crlf.byteLength > maximumHttpChunkLineBytes) {
          throw new Error("HTTP chunk trailers exceed the bounded limit");
        }
        trailerLines.push(line);
      }
      return;
    }

    if (byte === 0x0d) {
      trailerLineSawCr = true;
      return;
    }
    if (byte === 0x0a) {
      throw new Error("HTTP chunk trailer contains a bare LF");
    }
    trailerLine.push(byte);
    if (trailerLine.length > maximumHttpChunkLineBytes) {
      throw new Error("HTTP chunk trailer exceeds the bounded limit");
    }
  }

  function completeRequest(): void {
    state = "head";
    contentLengthRemaining = 0;
    chunkRemaining = 0;
    completedRequests++;
  }

  function combineOutput(output: Uint8Array[]): Uint8Array | undefined {
    if (output.length === 0) return undefined;
    if (output.length === 1) return output[0];
    return b4a.concat(output);
  }
}

interface ParsedHttpRequestHead {
  head: Uint8Array;
  contentLength?: number;
  chunked?: boolean;
  websocket?: boolean;
}

/** Rewrite one complete CRLF-delimited HTTP/1.1 request head. */
export function rewriteHttpRequestHead(
  head: Uint8Array,
  subscriberPublicKey: string,
): Uint8Array {
  return parseHttpRequestHead(head, subscriberPublicKey).head;
}

function parseHttpRequestHead(
  head: Uint8Array,
  subscriberPublicKey: string,
): ParsedHttpRequestHead {
  validateSubscriberPublicKey(subscriberPublicKey);
  if (head.byteLength > maximumHttpRequestHeadBytes) {
    throw new Error(
      `HTTP request head exceeds ${maximumHttpRequestHeadBytes} bytes`,
    );
  }

  const source = b4a.toString(head, "latin1");
  if (!source.endsWith("\r\n\r\n")) {
    throw new Error("HTTP request head is not CRLF terminated");
  }
  const lines = source.slice(0, -4).split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine || lines.length === 0) {
    throw new Error("HTTP request head is missing its request line or headers");
  }

  const request = /^([^ \t]+) ([^ \t]+) (HTTP\/[^ \t]+)$/.exec(requestLine);
  if (!request || request[3] !== "HTTP/1.1") {
    throw new Error("HTTP request must use a well-formed HTTP/1.1 request line");
  }
  const method = request[1];
  const target = request[2];
  if (!tokenPattern.test(method) || method === "CONNECT") {
    throw new Error("HTTP request method is unsupported");
  }
  if (hasInvalidRequestTarget(target)) {
    throw new Error("HTTP request target is malformed");
  }

  let hostCount = 0;
  let contentLengthCount = 0;
  let transferEncodingCount = 0;
  let contentLength: number | undefined;
  let chunked = false;
  let upgradeHeaderCount = 0;
  let websocketUpgrade = false;
  let connectionUpgrade = false;
  const forwardedHeaders: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line[0] === " " || line[0] === "\t") {
      throw new Error("HTTP request contains an invalid folded header");
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("HTTP request contains a malformed header");
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!tokenPattern.test(name) || hasInvalidHeaderValue(value)) {
      throw new Error("HTTP request contains a malformed header");
    }
    const lowerName = name.toLowerCase();
    const trimmedValue = value.trim();
    if (lowerName === "authorization") {
      continue;
    }
    if (lowerName === "host") {
      hostCount++;
      if (
        trimmedValue.length === 0 ||
        /[\s\u0000-\u001f\u007f-\u00ff]/.test(trimmedValue)
      ) {
        throw new Error("HTTP request contains an invalid Host header");
      }
    } else if (lowerName === "content-length") {
      contentLengthCount++;
      if (contentLengthCount > 1 || !/^[0-9]+$/.test(trimmedValue)) {
        throw new Error("HTTP request contains an ambiguous Content-Length");
      }
      const parsed = Number(trimmedValue);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error("HTTP request Content-Length is out of range");
      }
      contentLength = parsed;
    } else if (lowerName === "transfer-encoding") {
      transferEncodingCount++;
      if (transferEncodingCount > 1 || trimmedValue.length === 0) {
        throw new Error("HTTP request contains an ambiguous Transfer-Encoding");
      }
      if (trimmedValue.toLowerCase() !== "chunked") {
        throw new Error("HTTP request Transfer-Encoding is unsupported");
      }
      chunked = true;
    } else if (lowerName === "upgrade") {
      upgradeHeaderCount++;
      if (
        upgradeHeaderCount > 1 ||
        trimmedValue.toLowerCase() !== "websocket"
      ) {
        throw new Error("HTTP request protocol upgrades are unsupported");
      }
      websocketUpgrade = true;
    } else if (lowerName === "connection") {
      connectionUpgrade = connectionUpgrade ||
        parseConnectionTokens(trimmedValue).includes("upgrade");
    }
    forwardedHeaders.push(line);
  }

  if (hostCount !== 1) {
    throw new Error("HTTP/1.1 request must contain exactly one Host header");
  }
  if (chunked && contentLength !== undefined) {
    throw new Error("HTTP request has conflicting Content-Length and Transfer-Encoding");
  }
  const websocket = upgradeHeaderCount > 0 || connectionUpgrade;
  if (websocket) {
    if (method !== "GET" || !websocketUpgrade || !connectionUpgrade) {
      throw new Error(
        "HTTP request must be a valid WebSocket Upgrade with Upgrade: websocket and Connection: Upgrade",
      );
    }
    if (chunked || (contentLength !== undefined && contentLength !== 0)) {
      throw new Error("WebSocket Upgrade requests cannot carry a request body");
    }
  }

  return {
    head: b4a.from(
      `${requestLine}\r\n${forwardedHeaders.join("\r\n")}${
        forwardedHeaders.length > 0 ? "\r\n" : ""
      }Authorization: Kepos ${subscriberPublicKey}\r\n\r\n`,
      "latin1",
    ),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(chunked ? { chunked: true } : {}),
    ...(websocket ? { websocket: true } : {}),
  };
}

interface HttpTunnel extends Duplex {
  closeFrom: (trigger: string, error?: Error) => void;
}

interface HttpResponseGate extends Transform {
  arm: () => void;
}

function createHttpResponseGate(
  onClassified: (websocket: boolean) => void,
): HttpResponseGate {
  let armed = false;
  let classified = false;
  let sawUnarmedBytes = false;
  let responseHeadBuffer = b4a.alloc(0);
  let gate!: HttpResponseGate;
  gate = new Transform({
    transform(chunk: Uint8Array, _encoding: BufferEncoding, callback) {
      if (!armed || classified) {
        if (!armed && chunk.byteLength > 0) sawUnarmedBytes = true;
        callback(null, chunk);
        return;
      }

      const candidate = b4a.concat([responseHeadBuffer, b4a.from(chunk)]);
      const headerEnd = b4a.indexOf(candidate, requestHeadTerminator);
      if (headerEnd === -1) {
        if (candidate.byteLength > maximumHttpRequestHeadBytes) {
          callback(
            new Error(
              `HTTP Upgrade response head exceeds ${maximumHttpRequestHeadBytes} bytes`,
            ),
          );
          return;
        }
        responseHeadBuffer = candidate;
        callback();
        return;
      }

      const headLength = headerEnd + requestHeadTerminator.byteLength;
      if (headLength > maximumHttpRequestHeadBytes) {
        callback(
          new Error(
            `HTTP Upgrade response head exceeds ${maximumHttpRequestHeadBytes} bytes`,
          ),
        );
        return;
      }
      const responseHead = candidate.subarray(0, headLength);
      const responseBody = candidate.subarray(headLength);
      const websocket = parseHttpResponseHead(responseHead);
      responseHeadBuffer = b4a.alloc(0);
      classified = true;
      callback(
        null,
        responseBody.byteLength > 0
          ? b4a.concat([responseHead, responseBody])
          : responseHead,
      );
      queueMicrotask(() => onClassified(websocket));
    },
  }) as HttpResponseGate;
  gate.arm = (): void => {
    if (classified) return;
    if (sawUnarmedBytes) {
      throw new Error(
        "WebSocket Upgrade requires a fresh HTTP service tunnel with no outstanding response",
      );
    }
    armed = true;
  };
  return gate;
}

function parseHttpResponseHead(head: Uint8Array): boolean {
  const source = b4a.toString(head, "latin1");
  if (!source.endsWith("\r\n\r\n")) {
    throw new Error("HTTP Upgrade response head is not CRLF terminated");
  }
  const lines = source.slice(0, -4).split("\r\n");
  const statusLine = lines.shift();
  const status = /^HTTP\/1\.1 ([0-9]{3})(?:[ \t].*)?$/.exec(statusLine ?? "");
  if (!status) {
    throw new Error("HTTP Upgrade response must use HTTP/1.1");
  }

  let upgradeCount = 0;
  let websocketUpgrade = false;
  let connectionUpgrade = false;
  for (const line of lines) {
    if (line.length === 0 || line[0] === " " || line[0] === "\t") {
      throw new Error("HTTP Upgrade response contains an invalid folded header");
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("HTTP Upgrade response contains a malformed header");
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!tokenPattern.test(name) || hasInvalidHeaderValue(value)) {
      throw new Error("HTTP Upgrade response contains a malformed header");
    }
    const lowerName = name.toLowerCase();
    const trimmedValue = value.trim();
    if (lowerName === "upgrade") {
      upgradeCount++;
      websocketUpgrade =
        websocketUpgrade || trimmedValue.toLowerCase() === "websocket";
    } else if (lowerName === "connection") {
      connectionUpgrade = connectionUpgrade ||
        parseConnectionTokens(trimmedValue).includes("upgrade");
    }
  }

  const statusCode = Number(status[1]);
  if (statusCode !== 101) {
    if (statusCode >= 100 && statusCode < 200) {
      throw new Error("HTTP Upgrade response returned an unsupported informational status");
    }
    return false;
  }
  if (upgradeCount !== 1 || !websocketUpgrade || !connectionUpgrade) {
    throw new Error("HTTP 101 response is missing WebSocket upgrade headers");
  }
  return true;
}

/**
 * Bridge a publisher tunnel to its local target while rewriting every
 * subscriber request head. Response bytes travel back unchanged.
 */
export function bridgeHttp1(
  tunnel: HttpTunnel,
  target: Duplex,
  subscriberPublicKey: string,
): void {
  let forwarder!: HttpRequestForwarder;
  const responseGate = createHttpResponseGate((websocket) => {
    forwarder.releaseWebSocketUpgrade(websocket);
  });
  forwarder = createHttpRequestForwarder(subscriberPublicKey, {
    onWebSocketUpgrade: () => responseGate.arm(),
  });
  tunnel.pipe(forwarder).pipe(target);
  target.pipe(responseGate).pipe(tunnel);

  let closing = false;
  tunnel.once("error", (error) => {
    if (closing) return;
    closing = true;
    forwarder.destroy(error);
    responseGate.destroy(error);
    if (!target.destroyed) target.destroy(error);
  });
  forwarder.once("error", (error) => {
    if (closing) return;
    closing = true;
    tunnel.closeFrom("forwarder.error", error);
    responseGate.destroy(error);
    if (!target.destroyed) target.destroy(error);
  });
  responseGate.once("error", (error) => {
    if (closing) return;
    closing = true;
    tunnel.closeFrom("forwarder.error", error);
    forwarder.destroy(error);
    if (!target.destroyed) target.destroy(error);
  });
  target.once("error", (error) => {
    if (closing) return;
    closing = true;
    forwarder.destroy(error);
    responseGate.destroy(error);
    tunnel.closeFrom("target.error", error);
  });
  tunnel.once("close", () => {
    closing = true;
    forwarder.destroy();
    responseGate.destroy();
    if (!target.destroyed) target.destroy();
  });
  target.once("close", () => {
    if (!tunnel.destroyed && !closing) {
      closing = true;
      tunnel.closeFrom("target.close");
    }
  });
}

function validateSubscriberPublicKey(subscriberPublicKey: string): void {
  if (!publicKeyPattern.test(subscriberPublicKey)) {
    throw new Error("subscriber public key must be lowercase 64-hex text");
  }
}

function parseChunkSizeLine(line: Uint8Array): number {
  const source = b4a.toString(line, "latin1");
  let index = 0;
  while (index < source.length && isHexDigit(source.charCodeAt(index))) index++;
  if (index === 0) throw new Error("HTTP chunk-size line is malformed");

  const sizeText = source.slice(0, index);
  let size = 0;
  for (let position = 0; position < sizeText.length; position++) {
    const digit = hexValue(sizeText.charCodeAt(position));
    if (size > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 16)) {
      throw new Error("HTTP chunk size is out of range");
    }
    size = size * 16 + digit;
  }

  if (index < source.length && !parseChunkExtensions(source.slice(index))) {
    throw new Error("HTTP chunk-size extensions are malformed");
  }
  return size;
}

function parseChunkExtensions(source: string): boolean {
  let index = 0;
  while (index < source.length) {
    if (source[index] !== ";") return false;
    index++;
    const nameStart = index;
    while (index < source.length && isTokenCode(source.charCodeAt(index))) {
      index++;
    }
    if (index === nameStart) return false;
    if (source[index] !== "=") continue;
    index++;
    if (source[index] === '"') {
      index++;
      let closed = false;
      while (index < source.length) {
        const code = source.charCodeAt(index++);
        if (code === 0x22) {
          closed = true;
          break;
        }
        if (code === 0x5c) {
          if (index >= source.length || !isQuotedPairCode(source.charCodeAt(index))) {
            return false;
          }
          index++;
        } else if (!isQuotedTextCode(code)) {
          return false;
        }
      }
      if (!closed) return false;
    } else {
      const valueStart = index;
      while (index < source.length && isTokenCode(source.charCodeAt(index))) {
        index++;
      }
      if (index === valueStart) return false;
    }
  }
  return true;
}

function parseTrailerLine(line: Uint8Array): boolean {
  const source = b4a.toString(line, "latin1");
  const separator = source.indexOf(":");
  if (separator <= 0) throw new Error("HTTP chunk trailer is malformed");
  const name = source.slice(0, separator);
  const value = source.slice(separator + 1);
  if (!tokenPattern.test(name) || hasInvalidHeaderValue(value)) {
    throw new Error("HTTP chunk trailer is malformed");
  }
  const lowerName = name.toLowerCase();
  if (lowerName === "authorization") return false;
  if (
    lowerName === "content-length" ||
    lowerName === "transfer-encoding" ||
    lowerName === "host"
  ) {
    throw new Error("HTTP chunk trailer contains a forbidden framing field");
  }
  return true;
}

function parseConnectionTokens(value: string): string[] {
  const tokens = value.split(",").map((token) => token.trim());
  if (
    tokens.some(
      (token) => token.length === 0 || !tokenPattern.test(token),
    )
  ) {
    throw new Error("HTTP request contains a malformed Connection header");
  }
  return tokens.map((token) => token.toLowerCase());
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return code - 0x61 + 10;
}

function isTokenCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(String.fromCharCode(code))
  );
}

function isQuotedTextCode(code: number): boolean {
  return code === 0x09 || (code >= 0x20 && code !== 0x7f);
}

function isQuotedPairCode(code: number): boolean {
  return code === 0x09 || (code >= 0x20 && code <= 0x7e) || code >= 0x80;
}

function hasInvalidRequestTarget(target: string): boolean {
  if (target.length === 0) return true;
  for (let index = 0; index < target.length; index++) {
    const code = target.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) return true;
  }
  return false;
}

function hasInvalidHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
