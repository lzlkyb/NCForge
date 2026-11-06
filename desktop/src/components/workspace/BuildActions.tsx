import { Icon } from "../ui/icon";
import { Menu, MenuItem } from "../ui/Menu";
import type { BuildMaintenance } from "../../hooks/useBuildMaintenance";

export function BuildActions({ build, modulePath, activeModule }: { build: BuildMaintenance; modulePath: string | null; activeModule: string | null }) {
  return (
          <Menu
            width="w-60"
            trigger={(open, toggle) => (
              <button
                type="button"
                className="wb-status-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                title="清理产物 / 清理并重编 / 重建索引"
              >
                <Icon name="hammer" size={12} /> 构建操作
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  label={activeModule ? `清理并重编模块 ${activeModule}` : "清理并重编当前模块"}
                  icon="refresh"
                  disabled={!activeModule}
                  onClick={() => {
                    close();
                    if (modulePath && activeModule) void build.askRebuild(modulePath, activeModule);
                  }}
                />
                <MenuItem
                  label={activeModule ? `清理模块产物 ${activeModule}` : "清理当前模块产物"}
                  icon="trash"
                  disabled={!activeModule}
                  onClick={() => {
                    close();
                    if (modulePath && activeModule) void build.askClean(modulePath, activeModule);
                  }}
                />
                <MenuItem
                  label="清理并重编全部模块"
                  icon="refresh"
                  onClick={() => {
                    close();
                    void build.askRebuild();
                  }}
                />
                <MenuItem
                  label="清理全部模块产物"
                  icon="trash"
                  onClick={() => {
                    close();
                    void build.askClean();
                  }}
                />
                <MenuItem
                  label="重建类索引（下次编译重新扫描 jar）"
                  icon="refresh"
                  onClick={() => {
                    close();
                    build.askReindex();
                  }}
                />
                <MenuItem
                  label="清理编译临时文件"
                  icon="trash"
                  onClick={() => {
                    close();
                    build.cleanTmp();
                  }}
                />
              </>
            )}
          </Menu>
  );
}
