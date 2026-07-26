export class NdjsonReader {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private count = 0;

  constructor(private readonly maximumLineBytes: number, private readonly maximumRecords: number) {}

  push(chunk: Buffer): readonly unknown[] {
    const records: unknown[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.append(chunk.subarray(start, index));
      const line = Buffer.concat(this.chunks, this.bytes);
      this.chunks.length = 0;
      this.bytes = 0;
      this.count += 1;
      if (this.count > this.maximumRecords) throw new RangeError("worker emitted too many records");
      try { records.push(JSON.parse(line.subarray(0, line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length).toString("utf8"))); }
      catch { throw new TypeError("worker emitted malformed NDJSON"); }
      start = index + 1;
    }
    this.append(chunk.subarray(start));
    return records;
  }

  finish(): void { if (this.bytes !== 0) throw new TypeError("worker stdout ended with an incomplete NDJSON record"); }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.bytes + chunk.length > this.maximumLineBytes) throw new RangeError("worker emitted an oversized NDJSON line");
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }
}
