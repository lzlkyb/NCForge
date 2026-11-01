package ncforge.jdt;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.NullProgressMonitor;
import org.eclipse.jdt.core.Flags;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IType;
import org.eclipse.jdt.core.ITypeHierarchy;
import org.eclipse.jdt.core.JavaModelException;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.handlers.JsonRpcHelpers;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 类型层级：jdt.ls 0.57 没有 LSP 的 TypeHierarchy，这个扩展用 JDT 模型自己算。
 *
 * 由 jdt.ls 的 `org.eclipse.jdt.ls.core.delegateCommandHandler` 扩展点注册
 * （见 plugin.xml），客户端通过 `workspace/executeCommand` 调
 * `ncforge.typeHierarchy`，参数 `[{uri, line, character}]`（行 / 列 0 基）。
 *
 * 结果里的 uri 和 jdt.ls 自己的 Location 一样是「服务端看到的路径」：NCForge 的
 * 影子工程前缀由后端 `from_server` 换回真实路径，这里不做任何映射。
 */
public class TypeHierarchyHandler implements IDelegateCommandHandler {
    public static final String COMMAND = "ncforge.typeHierarchy";

    @Override
    public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        if (!COMMAND.equals(commandId)) {
            throw new IllegalArgumentException("Unknown command: " + commandId);
        }
        IProgressMonitor pm = monitor == null ? new NullProgressMonitor() : monitor;
        JsonObject p = asObject(arguments);
        String uri = p.get("uri").getAsString();
        int line = p.get("line").getAsInt();
        int character = p.get("character").getAsInt();

        ICompilationUnit cu = JDTUtils.resolveCompilationUnit(uri);
        if (cu == null) {
            throw new IllegalArgumentException("not a compilation unit: " + uri);
        }
        if (!cu.isConsistent()) {
            cu.makeConsistent(pm);
        }
        IType type = typeAt(cu, line, character);
        if (type == null) {
            return null;
        }

        Map<String, Object> out = new HashMap<String, Object>();
        out.put("type", toEntry(type, 0, false));
        out.put("supertypes", supertypes(type, pm));
        out.put("subtypes", subtypes(type, pm));
        return out;
    }

    /**
     * LSP4J 把无类型的 `arguments` 反序列化成 LinkedTreeMap，不是 JsonObject；
     * 两种都收，别假设是哪一种。
     */
    private static JsonObject asObject(List<Object> args) {
        if (args == null || args.isEmpty() || args.get(0) == null) {
            throw new IllegalArgumentException("missing params");
        }
        Object a = args.get(0);
        if (a instanceof JsonElement) {
            return ((JsonElement) a).getAsJsonObject();
        }
        return new Gson().toJsonTree(a).getAsJsonObject();
    }

    /** 光标处解析成类型：先按类型引用解析（`Shape s;` 里的 Shape），再退到声明处。 */
    private static IType typeAt(ICompilationUnit cu, int line, int character) throws JavaModelException {
        int offset;
        try {
            offset = JsonRpcHelpers.toOffset(cu, line, character);
        } catch (RuntimeException e) {
            // 行列越界（文档刚改过、前端光标没过 flush）：当成没结果，别抛给用户
            return null;
        }
        IJavaElement[] selected = cu.codeSelect(offset, 0);
        if (selected != null) {
            for (IJavaElement e : selected) {
                IType t = asType(e);
                if (t != null) {
                    return t;
                }
            }
        }
        return asType(cu.getElementAt(offset));
    }

    private static IType asType(IJavaElement e) {
        while (e != null && !(e instanceof IType)) {
            e = e.getParent();
        }
        return (IType) e;
    }

    private static List<Object> supertypes(IType root, IProgressMonitor pm) throws JavaModelException {
        ITypeHierarchy h = root.newSupertypeHierarchy(pm);
        if (h == null) {
            return new ArrayList<Object>();
        }
        IType[] all = h.getAllSupertypes(root);
        if (all == null || all.length == 0) {
            return new ArrayList<Object>();
        }
        // 深度按「离 root 最近的一条继承路径」算：菱形继承下按 BFS 取最短，
        // 列表缩进才和 IDEA 的类型层级一致
        Map<String, Integer> depth = new HashMap<String, Integer>();
        depth.put(key(root), 0);
        List<IType> frontier = new ArrayList<IType>();
        frontier.add(root);
        while (!frontier.isEmpty()) {
            List<IType> next = new ArrayList<IType>();
            for (IType t : frontier) {
                int d = depth.get(key(t));
                List<IType> parents = new ArrayList<IType>();
                IType sc = h.getSuperclass(t);
                if (sc != null) {
                    parents.add(sc);
                }
                IType[] ifs = h.getSuperInterfaces(t);
                if (ifs != null) {
                    parents.addAll(Arrays.asList(ifs));
                }
                for (IType p : parents) {
                    String k = key(p);
                    Integer known = depth.get(k);
                    if (known == null || known > d + 1) {
                        depth.put(k, d + 1);
                        next.add(p);
                    }
                }
            }
            frontier = next;
        }
        return entries(all, depth, pm);
    }

    private static List<Object> subtypes(IType root, IProgressMonitor pm) throws JavaModelException {
        ITypeHierarchy h = root.newTypeHierarchy(pm);
        if (h == null) {
            return new ArrayList<Object>();
        }
        IType[] all = h.getAllSubtypes(root);
        if (all == null || all.length == 0) {
            return new ArrayList<Object>();
        }
        Map<String, Integer> depth = new HashMap<String, Integer>();
        depth.put(key(root), 0);
        List<IType> frontier = new ArrayList<IType>();
        frontier.add(root);
        while (!frontier.isEmpty()) {
            List<IType> next = new ArrayList<IType>();
            for (IType t : frontier) {
                int d = depth.get(key(t));
                for (IType u : all) {
                    String k = key(u);
                    Integer known = depth.get(k);
                    if (known != null && known <= d + 1) {
                        continue;
                    }
                    if (isDirectChild(h, t, u)) {
                        depth.put(k, d + 1);
                        next.add(u);
                    }
                }
            }
            frontier = next;
        }
        return entries(all, depth, pm);
    }

    /** `u` 是否直接继承 / 实现 `t`（父类型都在同一个 hierarchy 里，查询是常数级）。 */
    private static boolean isDirectChild(ITypeHierarchy h, IType t, IType u) throws JavaModelException {
        IType sc = h.getSuperclass(u);
        if (sc != null && key(sc).equals(key(t))) {
            return true;
        }
        IType[] ifs = h.getSuperInterfaces(u);
        if (ifs != null) {
            for (IType i : ifs) {
                if (key(i).equals(key(t))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String key(IType t) {
        return t.getHandleIdentifier();
    }

    private static List<Object> entries(IType[] all, Map<String, Integer> depth, IProgressMonitor pm)
            throws JavaModelException {
        List<IType> sorted = new ArrayList<IType>(Arrays.asList(all));
        sorted.sort(new Comparator<IType>() {
            @Override
            public int compare(IType a, IType b) {
                Integer da = depth.get(key(a));
                Integer db = depth.get(key(b));
                int d = Integer.compare(da == null ? Integer.MAX_VALUE : da, db == null ? Integer.MAX_VALUE : db);
                if (d != 0) {
                    return d;
                }
                return a.getFullyQualifiedName('.').compareTo(b.getFullyQualifiedName('.'));
            }
        });
        List<Object> out = new ArrayList<Object>(sorted.size());
        for (IType t : sorted) {
            if (pm.isCanceled()) {
                break;
            }
            Integer d = depth.get(key(t));
            int dd = d == null ? -1 : d.intValue();
            out.add(toEntry(t, dd, dd == 1));
        }
        return out;
    }

    private static Map<String, Object> toEntry(IType type, int depth, boolean direct) throws JavaModelException {
        Map<String, Object> m = new HashMap<String, Object>();
        m.put("name", type.getElementName());
        m.put("qualifiedName", type.getFullyQualifiedName('.'));
        m.put("kind", kindOf(type));
        m.put("abstract", Flags.isAbstract(type.getFlags()));
        m.put("depth", depth);
        m.put("direct", direct);
        // 二进制类型（java.lang.Object、NC jar 里的类）可能拿不到源码位置，字段缺省即可
        m.put("location", JDTUtils.toLocation(type));
        return m;
    }

    private static String kindOf(IType type) throws JavaModelException {
        if (type.isAnnotation()) {
            return "annotation";
        }
        if (type.isEnum()) {
            return "enum";
        }
        if (type.isInterface()) {
            return "interface";
        }
        return "class";
    }
}
