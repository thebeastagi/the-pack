// the-pack voice — zero-dep protobuf codec for the SFU WS-adapter Packet
// (verbatim port from beast-super-app; B-V1 resolved 2026-07-20).
//   message Packet { uint32 sequenceNumber = 1; uint32 timestamp = 2; bytes payload = 5; }
const TAG_SEQ = 0x08;
const TAG_TS = 0x10;
const TAG_PAYLOAD = 0x2a;

function writeVarint(out, v) {
  let n = v >>> 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

export function readVarint(buf, pos) {
  let result = 0, shift = 0, i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error("packet: truncated varint");
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("packet: varint too long");
  }
  return { value: result >>> 0, next: i };
}

export function encodePacket(p) {
  const bytes = [];
  if (p.sequenceNumber !== 0) {
    bytes.push(TAG_SEQ);
    writeVarint(bytes, p.sequenceNumber);
  }
  if (p.timestamp !== 0) {
    bytes.push(TAG_TS);
    writeVarint(bytes, p.timestamp);
  }
  if (p.payload.length > 0) {
    bytes.push(TAG_PAYLOAD);
    writeVarint(bytes, p.payload.length);
    const head = new Uint8Array(bytes);
    const out = new Uint8Array(head.length + p.payload.length);
    out.set(head, 0);
    out.set(p.payload, head.length);
    return out;
  }
  return new Uint8Array(bytes);
}

export function decodePacket(buf) {
  const pkt = { sequenceNumber: 0, timestamp: 0, payload: new Uint8Array(0) };
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (field === 1 && wire === 0) {
      const v = readVarint(buf, pos);
      pkt.sequenceNumber = v.value;
      pos = v.next;
    } else if (field === 2 && wire === 0) {
      const v = readVarint(buf, pos);
      pkt.timestamp = v.value;
      pos = v.next;
    } else if (field === 5 && wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      if (pos + len.value > buf.length) throw new Error("packet: truncated payload");
      pkt.payload = buf.slice(pos, pos + len.value);
      pos += len.value;
    } else {
      if (wire === 0) pos = readVarint(buf, pos).next;
      else if (wire === 2) {
        const len = readVarint(buf, pos);
        pos = len.next + len.value;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else throw new Error(`packet: unsupported wire type ${wire}`);
    }
  }
  return pkt;
}

export function encodeIngestFrame(payload) {
  return encodePacket({ sequenceNumber: 0, timestamp: 0, payload });
}
