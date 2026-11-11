# A5 核查：UTF-8 源文件被 Eclipse 按 GBK 编

> 日期：2026-11-11　范围：`C:\work\aier\newar` 全部 `.java`（7472 个，不含 .svn/out/classes/META-INF）

## 结论

1. 「Eclipse 偏好里没登记、实际是 UTF-8 且含中文」的源文件是 **35 个**（规划文档和之前记录里写的是 53 个，和这次的 35 对不上，原因没查清：可能是当时的统计口径不同，也可能是之后有文件被登记或删除；本次统计方法已写在上面，以本次为准）。
   `.settings/org.eclipse.core.resources.prefs` 共 30 条登记，没有项目级默认编码，这些文件在 Eclipse 里落到工作区默认编码（推测是 GBK：磁盘上 2 个 class 的乱码方式与此吻合，但没有去核对 Eclipse 工作区偏好本身）。
2. 其中 **16 个有含中文的字符串字面量**——只有这些的运行行为会受影响；另 19 个只有注释或标识符里有中文，编出来的字节码不受影响。
3. 拿 `<模块>/classes` 里现存的 class 核对字面量（正确=按 UTF-8 编、乱码=按 GBK 解释后再编）：
   - `AddaskbillFromPuImpl`：3 个乱码；`AdjustpriceFromCtResource`：3 个乱码——**磁盘上现存 class 确实是乱码**。
   - `EntCertCheckImpl`、`ReferenceResolver`、`InvoicePullServiceImpl`、`VoucherBO` 等：字面量都是正确的（这些 class 多半是工作台编的，或不是 Eclipse 编的）。
   - 6 个类在 `classes` 下没有产物。
   - 「未找到」的字面量多是常量折叠 / 拼接后拆开了，不算异常。
4. **线上是否乱码：核实不了。** 在 `补丁\2026`（131 个 zip）与 `补丁\待上线补丁`（28 个 zip）里，这 13 个类**一个都没出现过**——说明至少这两个目录里的补丁没发过它们，线上的版本来自更早的包或产品本体。

## 影响

- 工作台是逐文件探测编码，编出来是对的；同一份源码用 Eclipse 编，上面这 16 个文件里的中文字符串会是乱码。
- 只有「某个补丁由 Eclipse 编、而源码是这 16 个之一」才会把乱码带上线；目前看到的磁盘产物里确认中招的是 `AddaskbillFromPuImpl` 与 `AdjustpriceFromCtResource` 两个。

## 含中文字符串字面量的 16 个文件（字面量个数）

| 文件 | 个数 |
|---|---|
| ct/src/private/nc/impl/ct/addaskbill/AddaskbillFromPuImpl.java | 4 |
| ct/src/public/nc/pubitf/ct/api/rest/AdjustpriceFromCtResource.java | 4 |
| gl/src/private/nc/bs/gl/voucher/VoucherBO.java | 144 |
| gl/src/private/nc/bs/gl/voucher/service/GLVoucherService4Fip.java | 10 |
| ic/src/private/nc/bs/aier/report/QueryJcOutAndYsInDataBO.java | 9 |
| ic/src/test/nc/bs/ic/m4d/insert/rule/MaterialOutDeductCabinetStockRuleTest.java | 1 |
| ic/src/test/nc/impl/ic/CabinetStockInitTest.java | 22 |
| ic/src/test/nc/impl/ic/CabinetStockServiceImplTest.java | 37 |
| moq/src/private/nc/pubimpl/moq/entcert/EntCertCheckImpl.java | 14 |
| price/src/private/nc/bs/price/tariff/tariffdetail/BatchTariffAdjustBP.java | 5 |
| pu/src/public/nc/prj/invoice/pull/convert/ReferenceResolver.java | 6 |
| pu/src/public/nc/prj/invoice/pull/service/InvoicePullController.java | 4 |
| pu/src/public/nc/prj/invoice/pull/service/InvoicePullServiceImpl.java | 2 |
| uapbd/src/client/nc/ui/uapbd/patchrelease/action/ReleaseAction.java | 12 |
| uapbd/src/private/nc/bs/uapbd/plugin/MaterialAutoLoadingPlugin.java | 52 |
| uapbd/src/private/nc/impl/uapbd/BasedataSerivceImpl.java | 63 |

（个数是粗略正则统计，含 `\` 转义的字面量也计入。）

## 只在注释/标识符里有中文的 19 个文件（不影响字节码）

ic/.../QueryJCDataForHHBO、pu/.../AierSSSignForHHBO、pu/.../IInvoicePullService、scmpub/.../BatchcodeSaveUpateBillRule，
uapbd 下 pharm_supplier_map 相关 7 个（AceAddHandler、AceHeadTailAfterEditHandler、AceHeadTailBeforeEditHandler、AceOrgChangeHandler、AcePharmSupplierMapMaintainProxy、CopyActionProcessor、PharmSupplierMapPluginPoint）、
N_UA99_DELETE / SAVE / SAVEBASE / UNAPPROVE / UNSAVEBILL 5 个、AcePharmSupplierMapPubServiceImpl、DecodedMultipartFile、TestApi1。

## 待决策（规划文档 §6 决策 2）

- **A. 以工作台为准**（编出来正确）。Eclipse 里这 16 个文件仍会编出乱码，所以出补丁一律用工作台编。
- **B. 以 Eclipse 为准**：把乱码也编进去，没有这个必要，**不建议**。
- **C. 两边标出来由人逐个决定**：在工作台里给这 35 个文件加提示，并把「Eclipse 偏好未登记」列成一张清单。
- 另一条治本的路：在 newar 的 `.settings/org.eclipse.core.resources.prefs` 里把这 16（或 35）个文件登记成 UTF-8。这会改 SVN 上共享的文件，需要你拍板，我不会自己动。
