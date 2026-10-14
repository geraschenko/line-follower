export type Line = Readonly<{
  text: string;
  /** 1-based; counts every line. */
  lineNumber: number;
  /** Offset from the first byte pushed. */
  byteOffset: number;
  /** Bytes from byteOffset through the terminating "\n" inclusive. */
  byteLength: number;
}>;

const NEWLINE = "\n".charCodeAt(0);

/** Splits on raw "\n" bytes and holds the torn suffix (an unfinished last
 *  line) until its
 *  newline arrives. Delivers every line, blank ones included. `text` is
 *  exactly the bytes before the "\n", including any "\r". Splitting before
 *  decoding keeps a UTF-8 code point split across chunks intact. */
export class LineReader {
  private tornSuffix = Buffer.alloc(0);
  private lineNumber = 0;
  private bytesPushed = 0;

  push(chunk: Buffer): Line[] {
    const dataByteOffset = this.bytesPushed - this.tornSuffix.length;
    this.bytesPushed += chunk.length;
    const data =
      this.tornSuffix.length === 0
        ? chunk
        : Buffer.concat([this.tornSuffix, chunk]);
    const lines: Line[] = [];
    let lineStart = 0;
    for (
      let lineEnd = data.indexOf(NEWLINE);
      lineEnd !== -1;
      lineEnd = data.indexOf(NEWLINE, lineStart)
    ) {
      this.lineNumber += 1;
      lines.push({
        text: data.toString("utf8", lineStart, lineEnd),
        lineNumber: this.lineNumber,
        byteOffset: dataByteOffset + lineStart,
        byteLength: lineEnd + 1 - lineStart,
      });
      lineStart = lineEnd + 1;
    }
    // Copied, not a subarray view: a view would pin the (possibly large)
    // chunk for as long as the line stays torn.
    this.tornSuffix =
      lineStart === data.length
        ? Buffer.alloc(0)
        : Buffer.from(data.subarray(lineStart));
    return lines;
  }
}
