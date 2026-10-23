// Just enough HL7 v2 (ER7) for the bridge: split a message into segments and fields, and build an ACK.

export type Segment = string[];

export function parse(message: string): Segment[] {
  return message
    .split(/\r\n|\r|\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("|");
      // MSH-1 is the field separator itself, so shift MSH fields to keep HL7 numbering.
      return fields[0] === "MSH" ? ["MSH", "|", ...fields.slice(1)] : fields;
    });
}

export const segments = (message: Segment[], id: string) => message.filter((s) => s[0] === id);

/** Component `n` (1 based) of a field. */
export const component = (field: string | undefined, n: number) => (field ?? "").split("^")[n - 1] ?? "";

const timestamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);

export function ack(message: Segment[], code: "AA" | "AE" | "AR", text = ""): string {
  const msh = segments(message, "MSH")[0] ?? [];
  const trigger = component(msh[9], 2);
  return [
    `MSH|^~\\&|${msh[5] ?? ""}|${msh[6] ?? ""}|${msh[3] ?? ""}|${msh[4] ?? ""}|${timestamp()}||ACK^${trigger}^ACK|ACK${msh[10] ?? ""}|P|${msh[12] ?? "2.5.1"}`,
    `MSA|${code}|${msh[10] ?? ""}${text ? `|${text}` : ""}`,
  ].join("\r");
}

/** MLLP framing: <VT> message <FS><CR>. */
export const frame = (message: string) => Buffer.from(`\x0b${message}\x1c\r`);

/** Pull complete messages out of a buffer, returning the leftover bytes. */
export function deframe(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(0x0b);
    const end = rest.indexOf(0x1c, start + 1);
    if (start < 0 || end < 0) return { messages, rest };
    messages.push(rest.subarray(start + 1, end).toString("utf8"));
    rest = rest.subarray(end + 1);
    if (rest[0] === 0x0d) rest = rest.subarray(1);
  }
}
