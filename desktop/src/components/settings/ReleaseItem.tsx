import { releaseText } from "../../lib/releaseReading";
import { ReleaseText } from "./ReleaseText";

/** Both bundled notes and server notes use the same compact title/body reading rhythm. */
export function ReleaseItem({ text }: { text: string }) {
  text = releaseText(text);
  const plain = text.replace(/\*\*/g, "");
  const split = plain.search(/：|:\s/);
  if (split < 0 || split > 40) return <p className="release-item-body"><ReleaseText text={text} /></p>;
  return <><h4 className="release-item-title">{plain.slice(0, split)}</h4><p className="release-item-body"><ReleaseText text={text.slice(text.indexOf(plain[split]) + 1).trim()} /></p></>;
}
