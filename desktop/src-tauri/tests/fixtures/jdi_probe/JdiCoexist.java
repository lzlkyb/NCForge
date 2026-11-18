import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.util.List;
import java.util.Map;

/**
 * 探针 D：**java-debug 已经占用的 JVM，能不能再开一条 JDWP 直连**。
 *
 * 这是「JDWP 直连补齐 force return / drop frame / 单线程恢复 / 方法断点 /
 * 字段观察点」这条技术路线的生死判据：HotSpot 的 JDWP server 理论上接受多个
 * 调试器连接，但 java-debug 会话正在管理同一个 VM —— 第二条连接会不会被拒、
 * 会不会互相踩断点，只能实测。
 *
 * 由 {@code tests/debug_jdwp_coexist_probe.rs} 驱动：那时 DAP 会话已 attach
 * 并停在断点上（main 挂起），本探针再 attach 同一端口，然后：
 *   1. attach 是否成功。
 *   2. 自建断点（Helper 第 17 行，SUSPEND_EVENT_THREAD）能不能收到命中。
 *   3. 命中后 popFrames 成不成（第二条连接改执行流，VM 认不认）。
 *
 * JDI 客户端跑在完整 JDK 17 上（本机 ufjdk 的 tools.jar 被裁剪）。
 */
public class JdiCoexist {

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
            System.out.println("RESULT: no-connector");
            return;
        }
        Map<String, Connector.Argument> cargs = conn.defaultArguments();
        cargs.get("hostname").setValue("127.0.0.1");
        cargs.get("port").setValue(String.valueOf(port));
        VirtualMachine vm;
        try {
            vm = conn.attach(cargs);
        } catch (Throwable t) {
            System.out.println("RESULT: attach-failed: " + t);
            return;
        }
        System.out.println("RESULT: attach-ok");
        System.out.println("  vm=" + vm.description());

        // Helper 可能已被 java-debug 的会话加载过：先直接找，找不到再等 ClassPrepare。
        ReferenceType helper = null;
        for (ReferenceType t : vm.allClasses()) {
            if (t.name().equals("Helper")) {
                helper = t;
                break;
            }
        }
        if (helper == null) {
            ClassPrepareRequest cpr = vm.eventRequestManager().createClassPrepareRequest();
            cpr.addClassFilter("Helper");
            cpr.enable();
            long deadline = System.currentTimeMillis() + 20_000;
            while (helper == null && System.currentTimeMillis() < deadline) {
                EventSet es = vm.eventQueue().remove(2_000);
                if (es == null) {
                    continue;
                }
                for (Event e : es) {
                    if (e instanceof ClassPrepareEvent) {
                        helper = ((ClassPrepareEvent) e).referenceType();
                    }
                }
                es.resume();
            }
        }
        if (helper == null) {
            System.out.println("RESULT: helper-not-found");
            vm.dispose();
            return;
        }
        System.out.println("RESULT: helper-loaded " + helper.name());

        Method pause = null;
        for (Method m : helper.methodsByName("pause")) {
            pause = m;
            break;
        }
        if (pause == null) {
            System.out.println("RESULT: no-pause-method");
            vm.dispose();
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
            System.out.println("RESULT: no-line-17");
            vm.dispose();
            return;
        }
        BreakpointRequest bp = vm.eventRequestManager().createBreakpointRequest(bpLoc);
        bp.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        bp.enable();
        System.out.println("RESULT: breakpoint-set line=17 policy=EVENT_THREAD");

        // 等命中：DAP 侧 continue 放行 main 后，本断点应该收到事件。
        // 队列里可能混着 java-debug 自己产生的事件，循环取到断点为止。
        EventSet set = null;
        long deadline = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < deadline) {
            EventSet candidate = vm.eventQueue().remove(3_000);
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
                set = candidate;
                break;
            }
            candidate.resume();
        }
        if (set == null) {
            System.out.println("RESULT: no-hit");
            vm.dispose();
            return;
        }
        ThreadReference stopped = null;
        for (Event e : set) {
            if (e instanceof BreakpointEvent) {
                stopped = ((BreakpointEvent) e).thread();
            }
        }
        if (stopped == null) {
            System.out.println("RESULT: no-thread");
            vm.dispose();
            return;
        }
        System.out.println("RESULT: hit " + stopped.frame(0).location() + " frames=" + stopped.frameCount());
        System.out.println("=== 命中时全部线程（EVENT_THREAD 策略下应只有事件线程挂起） ===");
        for (ThreadReference t : vm.allThreads()) {
            System.out.println("  " + t.name() + " suspended=" + t.isSuspended());
        }

        // 第二条连接改执行流：pop 掉 pause 帧，看 VM 认不认。
        try {
            StackFrame top = stopped.frame(0);
            stopped.popFrames(top);
            System.out.println("RESULT: popframes-ok after=" + stopped.frame(0).location());
        } catch (Throwable t) {
            System.out.println("RESULT: popframes-failed: " + t);
        }
        set.resume();
        System.out.println("=== 探针 D 结束 ===");
        vm.dispose();
    }

    private JdiCoexist() {
    }
}
