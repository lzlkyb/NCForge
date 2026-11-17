/** The edit row must use the depth of the visible tree, including flattened packages. */
export function treeRowInset(depth: number, packageView: boolean, file: boolean): number {
  return packageView
    ? 4 + depth * 10 + (file ? 18 : 0)
    : 6 + depth * 14 + (file ? 20 : 0);
}
