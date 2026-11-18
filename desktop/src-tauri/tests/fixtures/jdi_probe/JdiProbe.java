import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.util.List;
import java.util.Map;

/**
 * 探针 C：JDWP/JDI 直连的能力边界（drop frame / force return / 单线程挂起）。
 *
 * 由 {@code tests/debug_jdwp_probe.rs} 编译并运行：目标是本机 JDK 8 进程，
 * JDI 客户端跑在完整 JDK 17 上（jdk.jdi 模块完整；本机 ufjdk 的 tools.jar 被裁剪，
 * 缺 Capability / BreakpointRequest / forceEarlyReturn）。
 *
 * 三个问题：
 *   1. 断点用 SUSPEND_EVENT_THREAD 时，其他线程是否真的不停（→ 单线程挂起策略）。
 *   2. 命中断点后 ThreadReference.forceEarlyReturn（→ force return）成不成。
 *   3. 命中断点后 ThreadReference.popFrames（→ drop frame，非顶层帧）成不成。
 *
 * 全程 try/catch：打印的是事实，失败本身就是要的结论。
 * 注意 JDI 的 VirtualMachine 没有 capabilities() 查询（2026-11-18 javap 实测），
 * VM 能力只能靠这三项行为试探。
 */
public class JdiProbe {

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        VirtualMachineManager vmm = Bootstrap.virtualMachineManager();
        AttachingConnector conn = null;
        for (AttachingConnector c : vmm.attachingConnectors()) {
            if (c.transport() != null && c.transport().name().contains("socket")) {
                conn = c;
                break;
            }
        }
        if (conn == null) {
            System.out.println("没有 socket attaching connector");
            return;
        }
        Map<String, Connector.Argument> cargs = conn.defaultArguments();
        cargs.get("hostname").setValue("127.0.0.1");
        cargs.get("port").setValue(String.valueOf(port));
        VirtualMachine vm = conn.attach(cargs);
        System.out.println("=== VM ===");
        System.out.println("  " + vm.description());
        System.out.println("  version=" + vm.version());

        // suspend=y 的目标 attach 时 Caps 可能还没加载：等 ClassPrepare 再放行。
        ClassPrepareRequest cpr = vm.eventRequestManager().createClassPrepareRequest();
        cpr.addClassFilter("Helper");
        cpr.enable();
        vm.resume();
        // 事件集是异步的：resume 后先来的可能是 VMStart / ThreadStart，
        // 必须循环取集合，直到撞上 ClassPrepare（只取一个集合就放弃会误判「没加载」）。
        ReferenceType caps = null;
        long prepDeadline = System.currentTimeMillis() + 30_000;
        while (caps == null && System.currentTimeMillis() < prepDeadline) {
            EventSet es = vm.eventQueue().remove(5_000);
            for (Event e : es) {
                if (e instanceof ClassPrepareEvent) {
                    caps = ((ClassPrepareEvent) e).referenceType();
                }
            }
            es.resume();
        }
        if (caps == null) {
            System.out.println("30 秒内没等到 Helper 类加载");
            return;
        }
        System.out.println("=== Helper 已加载：" + caps.name() + " ===");

        // Helper.pause 第一行（Caps.java 第 17 行）：断点在这里，栈上有两层帧
        // [pause, main] —— popFrames 对非顶层帧才有意义（顶层帧没有调用者可回）。
        Method pause = null;
        for (Method m : caps.methodsByName("pause")) {
            pause = m;
            break;
        }
        if (pause == null) {
            System.out.println("Helper 里没有 pause 方法");
            return;
        }
        Location bpLoc = null;
        for (Location l : pause.allLineLocations()) {
            if (l.lineNumber() == 17) {
                bpLoc = l;
                break;
            }
        }
        if (bpLoc == null) {
            System.out.println("pause 里没有第 17 行");
            return;
        }

        // 断点策略 = 只停事件线程：这是「单线程挂起」的事实来源。
        BreakpointRequest bp = vm.eventRequestManager().createBreakpointRequest(bpLoc);
        bp.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        bp.enable();
        System.out.println("=== 断点已下（SUSPEND_EVENT_THREAD，Caps.pause line=17），等命中 ===");

        // 等命中断点（队列里可能混着线程启动等事件，循环取到断点为止）
        EventSet set = null;
        long deadline = System.currentTimeMillis() + 90_000;
        while (System.currentTimeMillis() < deadline) {
            EventSet candidate = vm.eventQueue().remove(10_000);
            boolean hit = false;
            for (Event e : candidate) {
                if (e instanceof BreakpointEvent) {
                    hit = true;
                }
            }
            if (hit) {
                set = candidate;
                break;
            }
            candidate.resume();
        }
        if (set == null) {
            System.out.println("90 秒内没命中断点");
            return;
        }
        ThreadReference stopped = null;
        for (Event e : set) {
            if (e instanceof BreakpointEvent) {
                stopped = ((BreakpointEvent) e).thread();
            }
        }
        if (stopped == null) {
            System.out.println("没抓到断点线程");
            return;
        }
        System.out.println("=== 命中断点：" + stopped.frame(0).location() + " ===");

        // 事实一：命中时**所有**线程的状态。bg-sleeper 应该还在跑（策略生效）。
        System.out.println("=== 命中断点时的全部线程 ===");
        for (ThreadReference t : vm.allThreads()) {
            System.out.println("  " + t.name() + " status=" + t.status() + " suspended=" + t.isSuspended());
        }

        // 事实二：forceEarlyReturn —— 从 pause 方法立即返回（void 方法给 VoidValue）。
        try {
            stopped.forceEarlyReturn(vm.mirrorOfVoid());
            System.out.println("② forceEarlyReturn(void) 成功");
        } catch (Throwable t) {
            System.out.println("② forceEarlyReturn 失败: " + t);
        }
        System.out.println("   force 后 top=" + (stopped.frameCount() > 0 ? stopped.frame(0).location() : "-"));
        // 不放行事件集，线程停在原地不会再次命中；popFrames 就没机会测
        set.resume();

        // force 返回后线程在 main 的循环里继续跑，会再次命中同一断点。
        // 等第二次命中，试 popFrames（drop frame）。
        EventSet set2 = null;
        deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            EventSet candidate = vm.eventQueue().remove(5_000);
            if (candidate == null) {
                continue;
            }
            boolean hit = false;
            for (Event e : candidate) {
                if (e instanceof BreakpointEvent) {
                    hit = true;
                }
            }
            if (hit) {
                set2 = candidate;
                break;
            }
            candidate.resume();
        }
        if (set2 == null) {
            System.out.println("force 后 30 秒内没再次命中断点");
            return;
        }
        ThreadReference stopped2 = null;
        for (Event e : set2) {
            if (e instanceof BreakpointEvent) {
                stopped2 = ((BreakpointEvent) e).thread();
            }
        }
        if (stopped2 == null || stopped2.frameCount() < 2) {
            System.out.println("第二次命中的栈不够两层，跳过 popFrames");
            return;
        }
        StackFrame top2 = stopped2.frame(0);
        System.out.println("=== 第二次命中：" + top2.location() + "（帧数 " + stopped2.frameCount() + "） ===");
        try {
            stopped2.popFrames(top2);
            System.out.println("③ popFrames(顶层帧) 成功，之后 top=" + stopped2.frame(0).location());
        } catch (Throwable t) {
            System.out.println("③ popFrames 失败: " + t);
        }

        // 事实三：单线程恢复（EVENT_THREAD 策略下其他线程本就没停，这一步看恢复本身）。
        try {
            stopped2.resume();
            System.out.println("④ resume(事件线程) 成功");
        } catch (Throwable t) {
            System.out.println("④ resume 失败: " + t);
        }
        System.out.println("=== 探针 C 结束 ===");
        vm.dispose();
    }

    private JdiProbe() {
    }
}
