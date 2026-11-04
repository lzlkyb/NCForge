import { beforeEach, describe, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({getText:vi.fn(()=>"提交文本"),getModel:vi.fn(),markSaved:vi.fn(),writeFile:vi.fn(),history:vi.fn()}));
vi.mock("./editorStore",()=>({getText:h.getText,getModel:h.getModel,markSaved:h.markSaved}));
vi.mock("./workspace",()=>({writeFile:h.writeFile,baseName:(p:string)=>p}));
vi.mock("./localHistory",()=>({captureLocalHistory:h.history}));
import { saveOne } from "./fileSave";
const target={path:"C:\\w\\A.java",encoding:"UTF-8" as const,hasBom:false,eol:"LF" as const,mtimeMs:1};
beforeEach(()=>{vi.clearAllMocks();h.history.mockResolvedValue(undefined);h.writeFile.mockResolvedValue(3);});
describe("保存提交版本",()=>{
  it("写入期间继续编辑，只标记提交时版本",async()=>{
    let version=4;const model={getAlternativeVersionId:()=>version};h.getModel.mockReturnValue(model);
    h.writeFile.mockImplementation(async()=>{version=5;return 3;});await saveOne(target);expect(h.markSaved).toHaveBeenCalledWith(target.path,4);expect(h.writeFile.mock.calls[0][0].text).toBe("提交文本");
  });
  it("原model已关闭或替换，完成回调不能标记新model已保存",async()=>{
    h.getModel.mockReturnValueOnce({getAlternativeVersionId:()=>4}).mockReturnValue({getAlternativeVersionId:()=>1});await saveOne(target);expect(h.markSaved).not.toHaveBeenCalled();
  });
});
