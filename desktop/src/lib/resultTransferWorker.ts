import { serializeTransfer, type TransferData, type TransferOptions } from "./resultTransfer";
self.onmessage = (event: MessageEvent<{ data: TransferData; options: TransferOptions }>) => {
  try { self.postMessage({ text: serializeTransfer(event.data.data, event.data.options) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
