import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { requestResourceDownload } from "../../lib/resourceActions";
import { RESOURCE_DOWNLOAD_LABELS, type ResourceId } from "../../lib/resourceMissing";

export function ResourceDownloadButton({ id }: { id: ResourceId }) {
  return <Button size="sm" variant="outline" onClick={() => requestResourceDownload(id)}>
    <Icon name="download" size={14} />{RESOURCE_DOWNLOAD_LABELS[id]}
  </Button>;
}
