import { useEffect, useRef } from "react";
import { subscribeSearchOpen, type SearchOpenRequest } from "../lib/searchOpenRequest";

export function useSearchOpenRequests(open: (request: SearchOpenRequest) => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => subscribeSearchOpen(request => latest.current(request)), []);
}
