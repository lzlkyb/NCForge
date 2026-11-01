import { describe, expect, it } from "vitest";
import { deleteDescription } from "./treeDeleteText";

/**
 * 删除确认的正文。这里的每一条都对应一次真实的误解：
 * 「以为删的是磁盘版本，其实手上那份未保存的修改才是唯一副本」。
 */
describe("deleteDescription", () => {
  it("什么都没有时不显示正文（只留标题里的文件名）", () => {
    expect(deleteDescription({ isDir: false, files: 1, labels: 0, unsaved: 0 })).toBeUndefined();
  });

  it("目录先说文件数，再说有几个标签会被关掉", () => {
    const t = deleteDescription({ isDir: true, files: 12, labels: 2, unsaved: 0 });
    expect(t).toBe("共 12 个文件。 其中 2 个已在标签中打开，删除后标签会一并关闭。");
  });

  it("后端数到上限就回 20001，正文里显示 20000+ 而不是那个精确值", () => {
    const t = deleteDescription({ isDir: true, files: 20001, labels: 0, unsaved: 0 });
    expect(t).toContain("共 20000+ 个文件");
    expect(t).not.toContain("20001");
  });

  it("单文件被打开时换一种说法（不报文件数）", () => {
    const t = deleteDescription({ isDir: false, files: 1, labels: 1, unsaved: 0 });
    expect(t).toBe("这个文件正在标签里打开，删除后标签会一并关闭。");
  });

  it("有未保存的修改必须单独说一句：磁盘那一半说清楚了不等于数据不会丢", () => {
    const t = deleteDescription({ isDir: false, files: 1, labels: 1, unsaved: 1 });
    expect(t).toContain("1 个有未保存的修改，删除后会一并丢失。");
  });

  it("引用提示只对文件、且带上前两处位置", () => {
    const t = deleteDescription({
      isDir: false,
      files: 1,
      labels: 0,
      unsaved: 0,
      refs: 7,
      refSamples: ["newar/gl/src/X.java", "pm/src/Y.java", "第三个不该出现"],
    });
    expect(t).toContain("别处还有 7 处提到这个类（如 newar/gl/src/X.java、pm/src/Y.java）");
    expect(t).not.toContain("第三个不该出现");
  });

  it("没有样本路径时引用提示也成立", () => {
    const t = deleteDescription({ isDir: false, files: 1, labels: 0, unsaved: 0, refs: 3 });
    expect(t).toBe("别处还有 3 处提到这个类，删除后那些地方会编译不过。");
  });

  it("目录不显示引用提示（那是类名级别的概念）", () => {
    const t = deleteDescription({ isDir: true, files: 3, labels: 0, unsaved: 0, refs: 9 });
    expect(t).not.toContain("提到这个类");
  });
});
