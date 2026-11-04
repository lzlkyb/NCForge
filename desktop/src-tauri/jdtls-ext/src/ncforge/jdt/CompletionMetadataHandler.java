package ncforge.jdt;

import java.util.*;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/** jdt.ls 0.57 omits deprecated metadata; use its existing JDT model on resolve. */
public final class CompletionMetadataHandler implements IDelegateCommandHandler {
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Map<?, ?> data = (Map<?, ?>) arguments.get(0);
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String) data.get("uri"));
        String declaration = (String) data.get("decl_signature");
        if (unit == null || declaration == null) return Collections.emptyMap();
        String fqcn = Signature.toString(Signature.getTypeErasure(declaration));
        IType type = unit.getJavaProject().findType(fqcn, monitor);
        if (type == null) return Collections.emptyMap();
        boolean deprecated = Flags.isDeprecated(type.getFlags());
        String name = (String) data.get("name");
        String signature = (String) data.get("signature");
        if (name != null && signature != null && signature.startsWith("(")) {
            String[] expected = Signature.getParameterTypes(signature);
            for (IMethod method : type.getMethods()) {
                if (!method.getElementName().equals(name)) continue;
                String[] actual = method.getParameterTypes();
                if (actual.length != expected.length) continue;
                boolean match = true;
                for (int i = 0; i < actual.length; i++) {
                    if (!normalized(actual[i]).equals(normalized(expected[i]))) match = false;
                }
                if (match) { deprecated |= Flags.isDeprecated(method.getFlags()); break; }
            }
        }
        return Collections.singletonMap("deprecated", Boolean.valueOf(deprecated));
    }
    private static String normalized(String signature) {
        return Signature.getTypeErasure(signature).replace('/', '.');
    }
}
