/** Keep JS lifetimes aligned with the motion tokens in index.css. */
export const MOTION = {
  feedback: 100,
  standard: 160,
  page: 140,
  enter: 180,
  exit: 140,
  ease: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

/** Waiting disclosure is independent of animation duration and business locks. */
export const WAIT_FEEDBACK = { reveal: 180, long: 10_000 } as const;
