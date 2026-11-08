import { serializeTransfer, type TransferData, type TransferOptions } from "./resultTransfer";
let data: TransferData, options: TransferOptions;
self.onmessage = (event: MessageEvent<{ kind: "init" | "rows" | "serialize"; data: TransferData; options: TransferOptions; rows: TransferData["rows"]; originalRows?: TransferData["rows"] }>) => {
  try {
    const message = event.data;
    if (message.kind === "init") { data = message.data; options = message.options; }
    else if (message.kind === "rows") { data.rows.push(...message.rows); if (message.originalRows) data.originalRows?.push(...message.originalRows); }
    else self.postMessage({ text: serializeTransfer(data, options) });
  }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
