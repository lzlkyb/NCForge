import { monaco } from "./monacoSetup";
import { blankLiterals } from "./javaModel";
import { context } from "./langProviderContext";
import { langRequest, langCapabilityEpoch } from "./lang";
import { getEditorPrefs } from "./editorPrefs";
import { workspaceEpoch } from "./workspaceEpoch";
import { javaLambdaParameters, javaHoverParameterType, type JavaLambdaParameter } from "./javaLambdaHints";

interface Signature { label: string; parameters?: { label: string | [number, number] }[]; }
interface Call { open: number; arguments: number[]; }
type HintTarget = { kind: "call"; offset: number; call: Call } | { kind: "lambda"; offset: number; parameter: JavaLambdaParameter };

/** 只分析可见范围，字符串/注释不参与逗号和括号计数，限制每次最多 8 个调用。 */
export function javaCallArguments(text: string, start: number, end: number): Call[] {
  const code = blankLiterals(text), calls: Call[] = [];
  const pattern = /([\w$]+)\s*\(/g; pattern.lastIndex = start;
  for (let match = pattern.exec(code); match && match.index < end && calls.length < 8; match = pattern.exec(code)) {
    if (/^(if|for|while|switch|catch|synchronized)$/.test(match[1])) continue;
    const lineStart = code.lastIndexOf("\n", match.index - 1) + 1;
    if (/\b(public|private|protected|void|class|interface)\b/.test(code.slice(lineStart, match.index))) continue;
    const open = pattern.lastIndex - 1, argumentsAt: number[] = [];
    let depth = 0, brackets = 0, braces = 0, generics = 0, next = open + 1;
    for (let i = open + 1; i < Math.min(code.length, open + 4000); i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") { if (!depth) { if (text.slice(next, i).trim()) argumentsAt.push(next + (text.slice(next, i).length - text.slice(next, i).trimStart().length)); break; } depth--; }
      else if (ch === "[") brackets++;
      else if (ch === "]") brackets--;
      else if (ch === "{") braces++;
      else if (ch === "}") braces--;
      else if (ch === "<" && /^[\w.$\s?,[\]&<>]*>/.test(code.slice(i + 1, i + 256)) && /(?:[A-Z][\w$]*|\.)\s*$/.test(code.slice(open + 1, i))) generics++;
      else if (ch === ">" && generics) generics--;
      if (ch === "," && !depth && !brackets && !braces && !generics) { argumentsAt.push(next + (text.slice(next, i).length - text.slice(next, i).trimStart().length)); next = i + 1; }
    }
    if (argumentsAt.length) calls.push({ open, arguments: argumentsAt });
  }
  return calls;
}

export function signatureParameterNames(signature: Signature): string[] {
  return (signature.parameters ?? []).map(parameter => {
    const label = typeof parameter.label === "string" ? parameter.label : signature.label.slice(...parameter.label);
    return /([\w$]+)\s*(?:\[\s*\])*\s*$/.exec(label)?.[1] ?? "";
  });
}

export function registerJavaParameterHints(): void {
  const cache = new WeakMap<monaco.editor.ITextModel, { version: number; epoch: number; capability: number; values: Map<string, Signature | string | null> }>();
  monaco.languages.registerInlayHintsProvider("java", {
    provideInlayHints: async (model, range, token) => {
      if (!getEditorPrefs().inlayHints || token.isCancellationRequested) return null;
      const version = model.getVersionId(), epoch = workspaceEpoch(), capability = langCapabilityEpoch(), deadline = Date.now() + 2500;
      const valid = () => !model.isDisposed() && model.getVersionId() === version && workspaceEpoch() === epoch && langCapabilityEpoch() === capability && !token.isCancellationRequested && getEditorPrefs().inlayHints;
      const text = model.getValue(), start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: 1 }), end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: model.getLineMaxColumn(range.endLineNumber) });
      const targets: HintTarget[] = [
        ...javaCallArguments(text, start, end).map(call => ({ kind: "call" as const, offset: call.open, call })),
        ...javaLambdaParameters(text, start, end).map(parameter => ({ kind: "lambda" as const, offset: parameter.start, parameter })),
      ].sort((a, b) => a.offset - b.offset);
      let data = cache.get(model);
      if (!data || data.version !== version || data.epoch !== epoch || data.capability !== capability) { data = { version, epoch, capability, values: new Map() }; cache.set(model, data); }
      const hints: monaco.languages.InlayHint[] = [];
      let requests = 0;
      for (const target of targets) {
        if (!valid()) return null;
        if (Date.now() >= deadline) break;
        const key = `${target.kind}:${target.offset}`;
        let value = data.values.get(key);
        if (value === undefined) {
          if (requests >= 8) break;
          const position = model.getPositionAt(target.offset + (target.kind === "call" ? 1 : 0)), ctx = await context(model, position);
          if (!ctx || !valid()) return null;
          if (Date.now() >= deadline) break;
          requests++;
          try {
            const timeout = Math.max(1, Math.min(1000, deadline - Date.now()));
            if (target.kind === "lambda") {
              const result = await langRequest<{ contents?: unknown }>("textDocument/hover", ctx.path, { position: ctx.position }, timeout);
              value = javaHoverParameterType(result?.contents, target.parameter.name);
            } else {
              const result = await langRequest<{ signatures?: Signature[]; activeSignature?: number }>("textDocument/signatureHelp", ctx.path, { position: ctx.position }, timeout);
              value = result?.signatures?.[result.activeSignature ?? 0] ?? null;
            }
            if (!valid()) return null;
            data.values.set(key, value);
            if (data.values.size > 100) data.values.delete(data.values.keys().next().value!);
          } catch { if (!valid()) return null; continue; }
        }
        if (target.kind === "lambda") {
          if (typeof value === "string") hints.push({ position: model.getPositionAt(target.offset + target.parameter.name.length), label: `: ${value}`, kind: monaco.languages.InlayHintKind.Type, paddingLeft: true });
        } else if (value && typeof value !== "string") {
          const names = signatureParameterNames(value), call = target.call;
          for (let i = 0; i < Math.min(names.length, call.arguments.length); i++) {
            if (!names[i] || text.slice(call.arguments[i]).startsWith(names[i]) && !/[\w$]/.test(text[call.arguments[i] + names[i].length] ?? "")) continue;
            hints.push({ position: model.getPositionAt(call.arguments[i]), label: `${names[i]}:`, kind: monaco.languages.InlayHintKind.Parameter, paddingRight: true });
          }
        }
      }
      return valid() ? { hints, dispose: () => {} } : null;
    },
  });
}
