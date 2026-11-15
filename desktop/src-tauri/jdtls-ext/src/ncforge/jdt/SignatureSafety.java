package ncforge.jdt;

import java.util.*;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;

/** Reject unsafe name capture before producing a signature plan; qualified members stay explicit. */
final class SignatureSafety {
    static String typeText(SingleVariableDeclaration parameter) {
        String type = parameter.getType().toString();
        for (int dimension = 0; dimension < parameter.getExtraDimensions(); dimension++) type += "[]";
        return type;
    }
    static boolean sameType(SingleVariableDeclaration left, SingleVariableDeclaration right) {
        return typeText(left).equals(typeText(right));
    }
    static void checkTypeEdits(IMethod[] methods, boolean changed) throws JavaModelException {
        if (!changed) return;
        // A shared textual type cannot represent all specializations. Preserve unchanged types,
        // but reject explicit edits rather than silently ignoring the user's requested type.
        for (IMethod method : methods) {
            if (method.getTypeParameters().length > 0) throw genericTypes();
            for (IType type = method.getDeclaringType(); type != null; type = type.getDeclaringType()) {
                if (type.getTypeParameters().length > 0) throw genericTypes();
            }
        }
    }
    private static IllegalArgumentException genericTypes() {
        return new IllegalArgumentException("泛型关联签名的类型修改或新增参数无法安全同步，请先明确各声明的实际类型后单独处理");
    }
    static void checkNames(MethodDeclaration declaration, Set<String> introduced, Set<IVariableBinding> parameters, Map<IVariableBinding,String> renames) {
        if (introduced.isEmpty() || declaration.getBody() == null) return;
        declaration.getBody().accept(new ASTVisitor() {
            public boolean visit(SimpleName name) {
                IBinding binding = name.resolveBinding();
                if (binding instanceof IVariableBinding && parameters.contains(binding)) {
                    String target = renames.get(binding);
                    if (target != null && capturedByInnerType(name, target, declaration)) throw conflict(target);
                    return true;
                }
                if (!introduced.contains(name.getIdentifier())) return true;
                ASTNode parent = name.getParent();
                if ((parent instanceof QualifiedName && ((QualifiedName)parent).getName() == name)
                    || (parent instanceof FieldAccess && ((FieldAccess)parent).getName() == name)
                    || (parent instanceof SuperFieldAccess && ((SuperFieldAccess)parent).getName() == name)) return true;
                // Include lambda parameters and local/anonymous class declarations: moving a
                // parameter into those scopes can capture references or create illegal locals.
                // Package prefixes also start static expressions; a parameter named java
                // would hide the package in java.lang.Math instead of preserving that binding.
                if (binding == null || binding instanceof IVariableBinding
                    || ((binding instanceof ITypeBinding || binding instanceof IPackageBinding) && ((parent instanceof QualifiedName && ((QualifiedName)parent).getQualifier() == name)
                        || (parent instanceof MethodInvocation && ((MethodInvocation)parent).getExpression() == name)))) {
                    throw conflict(name.getIdentifier());
                }
                return true;
            }
        });
    }
    private static IllegalArgumentException conflict(String name) {
        return new IllegalArgumentException("新参数名会捕获已有引用或与局部声明冲突：" + name + "；请换一个名称");
    }
    private static boolean capturedByInnerType(SimpleName reference, String name, MethodDeclaration declaration) {
        for (ASTNode scope = reference.getParent(); scope != null && scope != declaration; scope = scope.getParent()) {
            ITypeBinding type = scope instanceof AbstractTypeDeclaration ? ((AbstractTypeDeclaration)scope).resolveBinding()
                : scope instanceof AnonymousClassDeclaration ? ((AnonymousClassDeclaration)scope).resolveBinding() : null;
            if (type != null && hasField(type, name, new HashSet<ITypeBinding>())) return true;
        }
        return false;
    }
    private static boolean hasField(ITypeBinding type, String name, Set<ITypeBinding> seen) {
        if (type == null || !seen.add(type)) return false;
        for (IVariableBinding field : type.getDeclaredFields()) if (field.getName().equals(name)) return true;
        if (hasField(type.getSuperclass(), name, seen)) return true;
        for (ITypeBinding parent : type.getInterfaces()) if (hasField(parent, name, seen)) return true;
        return false;
    }
}
